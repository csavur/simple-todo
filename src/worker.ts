// The plugin's worker. Because the manifest has a status bar item, Orca keeps it running while
// the plugin is enabled. It keeps the status bar in step with the task list and does what a
// sandboxed panel may not: list and open workspaces, launch agents and type into terminals.
// Workspaces of this Orca go through the plugin host API. Paired Orca servers, and the list of
// running agents beyond the focused workspace, are only reachable through the `orca` CLI.
import type { OrcaWorkerApi } from 'orca/worker'
import { dayOf, parseTodos, statusBarOf, summaryOf } from './core/todos.ts'
import { homedir } from 'node:os'
import { skillText } from './core/skill.ts'
import { DEFAULT_LIST, PREFS_KEY, TODOS_KEY, type Todo } from './core/types.ts'
import type { OrcaProject, Outcome } from './protocol.ts'
import { agentStates, listAgents, sendToAgent, terminalIn } from './worker/agents.ts'
import {
  applyAgentStates,
  autoArchive,
  dueReminder,
  inboxTodos,
  linkedTodos,
  parseSettings,
  promptOf,
  type Reminded,
  type Settings
} from './worker/chores.ts'
import { runOrcaCli, type OrcaCli } from './worker/cli.ts'
import { inboxFile, type InboxFile } from './worker/files.ts'
import { listRemoteProjects, mergeProjects } from './worker/remote.ts'
import { syncSkill } from './worker/skill.ts'

const STATUS_BAR_ITEM = 'open'
const PANEL_ID = 'simple-todo'
const REMINDED_KEY = 'reminded'
/** The text of the agent skill the worker installed, while that copy is still its own. */
const SKILL_KEY = 'skill'

/** How often the worker looks: at the inbox, at the agents to-dos were sent to, and at the clock
 *  (which is also how often it checks the agent skill). */
const INBOX_MS = 5_000
const AGENTS_MS = 20_000
const CHORES_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs a host action and reports a failure as a message instead of throwing at the panel. */
async function attempt<T extends object>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, ...(await run()) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

type ListedWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  branch: string | null
}

/** Workspaces grouped into projects: Orca names the project of each; a workspace without one stands alone. */
export function groupProjects(workspaces: readonly ListedWorkspace[]): OrcaProject[] {
  const projects = new Map<string, OrcaProject>()
  for (const workspace of workspaces) {
    const name = workspace.project || workspace.name
    const project = projects.get(name) ?? { name, workspaces: [] }
    project.workspaces.push({
      id: workspace.id,
      kind: workspace.kind,
      name: workspace.name,
      branch: workspace.branch
    })
    projects.set(name, project)
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface WorkerOptions {
  /** The inbox file; tests stand in for the disk. */
  inbox?: InboxFile
  /** The home folder to keep the agent skill installed in. Without one the skill is left alone. */
  skillHome?: string
  /** Whether to keep looking on timers. Tests turn them off and call for a look themselves. */
  timers?: boolean
}

/** What a test may ask the worker to do now, instead of waiting for its timers. */
export interface WorkerHandle {
  /** A worker module is a bag of exports. */
  [key: string]: unknown
  default: (orca: OrcaWorkerApi) => void
  deactivate: () => void
  /** One look at the inbox, the agents and the clock. */
  look: () => Promise<void>
}

/**
 * The worker module, given the way to run the `orca` CLI. Workspaces of this Orca go through
 * the plugin host API; paired Orca servers and agents beyond the focused workspace can only be
 * reached by the CLI.
 */
export function createWorker(cli: OrcaCli, options: WorkerOptions = {}): WorkerHandle {
  let stop = (): void => undefined
  let look = async (): Promise<void> => undefined
  return {
    default(orca) {
      const running = start(orca, cli, options)
      stop = running.stop
      look = running.look
    },
    deactivate: () => stop(),
    look: () => look()
  }
}

const worker = createWorker(runOrcaCli, { skillHome: homedir() })
export default worker.default
/** Orca awaits this before it stops the worker. */
export const deactivate = worker.deactivate

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function start(
  orca: OrcaWorkerApi,
  cli: OrcaCli,
  options: WorkerOptions
): { stop: () => void; look: () => Promise<void> } {
  const inbox = options.inbox ?? inboxFile()

  async function loadTodos(): Promise<Todo[]> {
    return parseTodos(await orca.storage.get(TODOS_KEY))
  }

  let shown = ''
  async function refreshStatusBar(): Promise<void> {
    try {
      const state = statusBarOf(await loadTodos(), dayOf(Date.now()))
      const signature = JSON.stringify(state)
      if (signature === shown) {
        return
      }
      await orca.host.call(
        'statusBar.update',
        state.visible
          ? { id: STATUS_BAR_ITEM, visible: true, text: state.text, tone: state.tone, tooltip: state.tooltip }
          : { id: STATUS_BAR_ITEM, visible: false }
      )
      shown = signature
    } catch (error) {
      orca.log(`status bar update failed: ${messageOf(error)}`)
    }
  }

  // The panel writes the list to storage; every write lands here.
  orca.storage.onDidChange(({ key }) => {
    if (key === TODOS_KEY) {
      void refreshStatusBar()
    }
  })
  void refreshStatusBar()

  orca.commands.register('simple-todo.summary', async () => summaryOf(await loadTodos()))

  async function settings(): Promise<Settings> {
    try {
      return parseSettings(await orca.settings.get())
    } catch {
      // Older Orca, or settings not granted: the defaults.
      return parseSettings({})
    }
  }

  // Every change to the list is read, changed and written in turn, so a look at the inbox and
  // a look at the agents never write over each other.
  let queue: Promise<unknown> = Promise.resolve()
  function changeTodos(change: (todos: Todo[]) => readonly Todo[] | Promise<readonly Todo[]>): Promise<void> {
    const run = queue.then(async () => {
      const before = await loadTodos()
      const after = await change(before)
      if (after !== before) {
        await orca.storage.set(TODOS_KEY, after as never)
      }
    })
    queue = run.catch(() => undefined)
    return run
  }

  // --- quick add ---------------------------------------------------------------------------

  /** Set when the shortcut is pressed; a panel that was not open yet asks for it as it loads. */
  let composePending = false
  let pluginKey: string | undefined

  /** This plugin's key, which `orca plugin open` needs: the installed one that ends in its id. */
  async function findPluginKey(): Promise<string | undefined> {
    if (pluginKey) {
      return pluginKey
    }
    const listed = (await cli(['plugin', 'list'])) as { plugins?: unknown } | unknown[] | null
    const plugins = Array.isArray(listed) ? listed : Array.isArray(listed?.plugins) ? listed.plugins : []
    const mine = plugins.filter(
      (plugin): plugin is { pluginKey: string; isDev?: boolean } =>
        typeof (plugin as { pluginKey?: unknown })?.pluginKey === 'string' &&
        (plugin as { pluginKey: string }).pluginKey.endsWith(`.${PANEL_ID}`)
    )
    // A development copy overrides an installed one, so it is the one running this code.
    pluginKey = (mine.find((plugin) => plugin.isDev) ?? mine[0])?.pluginKey
    return pluginKey
  }

  orca.commands.register('simple-todo.quickAdd', async () => {
    composePending = true
    // An open panel hears this at once; one that has to open first asks with `compose.take`.
    orca.panels.post('compose', {})
    try {
      const key = await findPluginKey()
      if (!key) {
        return 'Open the Simple Todo panel to add a to-do.'
      }
      await cli(['plugin', 'open', key, `--panel=${PANEL_ID}`])
      return ''
    } catch (error) {
      return `Could not open the Simple Todo panel: ${messageOf(error)}`
    }
  })

  orca.panels.handle('compose.take', () => {
    const pending = composePending
    composePending = false
    return { pending }
  })

  orca.panels.handle('inbox.path', () => ({ path: inbox.path }))

  // --- looking, on a timer -----------------------------------------------------------------

  /** Takes in what agents appended to the inbox file. */
  async function takeInbox(): Promise<void> {
    // Taken out of the file first: if storing fails the lines are lost, but never added twice.
    const source = await inbox.take()
    if (!source.trim()) {
      return
    }
    const now = Date.now()
    const prefs = (await orca.storage.get(PREFS_KEY)) as { list?: unknown } | null
    const list = typeof prefs?.list === 'string' && prefs.list ? prefs.list : DEFAULT_LIST
    const added = inboxTodos(source, list, newId, now, dayOf(now))
    if (added.length > 0) {
      await changeTodos((todos) => [...todos, ...added])
      orca.log(`added ${added.length} to-do(s) from the inbox`)
    }
  }

  /** Asks what the agents that were sent to-dos are doing now. */
  async function followAgents(): Promise<void> {
    const linked = linkedTodos(await loadTodos())
    if (linked.length === 0) {
      return
    }
    const environments = [...new Set(linked.map((todo) => todo.agent?.environmentId ?? ''))]
    const [{ states, reachable }, { autoComplete }] = await Promise.all([
      agentStates(cli, environments, (message) => orca.log(message)),
      settings()
    ])
    await changeTodos((todos) => applyAgentStates(todos, states, reachable, autoComplete, Date.now()))
  }

  /** What follows the clock: putting old done to-dos away, and reminding of due days. */
  async function chores(): Promise<void> {
    const { archiveAfterDays, dueReminders } = await settings()
    const now = Date.now()
    await changeTodos((todos) => autoArchive(todos, archiveAfterDays, now))
    // The day may have turned: an open to-do can become overdue without anything changing.
    await refreshStatusBar()
    if (!dueReminders) {
      return
    }
    const stored = (await orca.storage.get(REMINDED_KEY)) as Reminded | null
    const before = stored && typeof stored === 'object' ? stored : {}
    const { reminder, reminded } = dueReminder(await loadTodos(), before, dayOf(now))
    if (JSON.stringify(reminded) !== JSON.stringify(before)) {
      // Recorded before showing: a notification that fails is not retried every minute.
      await orca.storage.set(REMINDED_KEY, reminded)
    }
    if (reminder) {
      await orca.host.call('notifications.show', reminder)
    }
  }

  /** Installs, updates or removes the agent skill, as the setting says. */
  let skillNotes = ''
  async function keepSkill(): Promise<void> {
    if (options.skillHome === undefined) {
      return
    }
    const { agentSkill } = await settings()
    const stored = await orca.storage.get(SKILL_KEY)
    const before = typeof stored === 'string' ? stored : null
    const { written, notes } = await syncSkill(options.skillHome, skillText(), agentSkill, before)
    if (written !== before) {
      await (written === null ? orca.storage.delete(SKILL_KEY) : orca.storage.set(SKILL_KEY, written))
      orca.log(written === null ? 'removed the agent skill' : 'installed the agent skill')
    }
    // Said once, not on every look.
    if (notes.join('\n') !== skillNotes) {
      skillNotes = notes.join('\n')
      notes.forEach((note) => orca.log(note))
    }
  }

  const guarded = (name: string, run: () => Promise<void>) => (): Promise<void> =>
    run().catch((error: unknown) => orca.log(`${name} failed: ${messageOf(error)}`))
  const lookAtInbox = guarded('inbox', takeInbox)
  const lookAtAgents = guarded('agents', followAgents)
  const lookAtClock = guarded('chores', chores)
  // One at a time: a setting flipped during a look must not write while the look removes.
  let skillRun: Promise<void> = Promise.resolve()
  const lookAtSkill = (): Promise<void> => (skillRun = skillRun.then(guarded('agent skill', keepSkill)))
  const settingsWatch = options.skillHome === undefined ? null : orca.settings.onDidChange(() => void lookAtSkill())

  const timers =
    options.timers === false
      ? []
      : [
          setInterval(() => void lookAtInbox(), INBOX_MS),
          setInterval(() => void lookAtAgents(), AGENTS_MS),
          setInterval(() => void lookAtClock(), CHORES_MS),
          // The setting is heard as it changes; this puts back a skill that was removed by hand.
          setInterval(() => void lookAtSkill(), CHORES_MS)
        ]
  if (options.timers !== false) {
    void lookAtInbox()
    void lookAtClock()
    void lookAtSkill()
  }

  orca.panels.handle('projects.list', () =>
    attempt(async () => {
      const [local, remote] = await Promise.all([
        // Older Orca has no workspace.list: the panel then offers hand-typed names only.
        orca.host.has('workspace.list')
          ? orca.host.call('workspace.list').then(({ workspaces }) => groupProjects(workspaces))
          : [],
        listRemoteProjects(cli, (message) => orca.log(message))
      ])
      return { projects: mergeProjects(local, remote) }
    })
  )

  orca.panels.handle('workspace.open', ({ workspaceId, environmentId }) =>
    attempt(async () => {
      if (environmentId) {
        await cli([
          'worktree',
          'activate',
          `--environment=${environmentId}`,
          `--worktree=id:${workspaceId}`
        ])
      } else {
        await orca.host.call('workspace.open', { workspaceId })
      }
      return {}
    })
  )

  orca.panels.handle('agents.list', () =>
    attempt(async () => ({ agents: await listAgents(cli, (message) => orca.log(message)) }))
  )

  orca.panels.handle('agent.send', ({ terminalId, environmentId, prompt }) =>
    attempt(async () => {
      await sendToAgent(cli, { terminalId, environmentId }, promptOf(prompt, await settings()))
      return {}
    })
  )

  orca.panels.handle('agent.launch', ({ workspaceId, environmentId, agent, prompt }) =>
    attempt(async (): Promise<{ terminalId?: string }> => {
      const text = promptOf(prompt, await settings())
      if (environmentId) {
        const answer = await cli([
          'agent',
          'launch',
          `--environment=${environmentId}`,
          `--worktree=id:${workspaceId}`,
          `--agent=${agent}`,
          // One argument with `=`: a task that starts with `-` is still the prompt, not a flag.
          `--prompt=${text}`
        ])
        const terminalId = terminalIn(answer)
        return terminalId ? { terminalId } : {}
      }
      const { terminalId } = await orca.host.call('agent.launch', { workspaceId, agent, prompt: text })
      return terminalId ? { terminalId } : {}
    })
  )

  return {
    stop() {
      timers.forEach((timer) => clearInterval(timer))
      settingsWatch?.dispose()
    },
    async look() {
      await lookAtInbox()
      await lookAtAgents()
      await lookAtClock()
      await lookAtSkill()
    }
  }
}
