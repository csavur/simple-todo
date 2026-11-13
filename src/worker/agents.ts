// Agents already running in a terminal, on this Orca and on every paired Orca server. The
// plugin host API lists only those of the focused workspace, so they are read through the CLI,
// which also covers every workspace here and this Orca's SSH hosts.
import { AGENT_STATES, type AgentState } from '../core/types.ts'
import type { AgentOption } from '../protocol.ts'
import type { OrcaCli } from './cli.ts'
import { listEnvironments } from './remote.ts'

const LIMIT = 200

type Environment = { id: string; name: string }

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The terminals of one runtime that run an agent and can be typed into. */
/** The agents Orca reports per pane (`worktree ps`), by `<tab id>:<pane id>`. */
function agentsByPane(ps: unknown): Map<string, { kind: string | null; name: string | null }> {
  const byPane = new Map<string, { kind: string | null; name: string | null }>()
  for (const worktree of ((ps as { worktrees?: unknown } | null)?.worktrees as unknown[] | undefined) ?? []) {
    for (const agent of ((worktree as { agents?: unknown } | null)?.agents as unknown[] | undefined) ?? []) {
      const { paneKey, agentType, conversationName } = (agent ?? {}) as Record<string, unknown>
      if (typeof paneKey === 'string') {
        byPane.set(paneKey, { kind: text(agentType), name: text(conversationName) })
      }
    }
  }
  return byPane
}

async function listRuntimeAgents(cli: OrcaCli, environment?: Environment): Promise<AgentOption[]> {
  const flag = environment ? [`--environment=${environment.id}`] : []
  // The terminal list names an agent only while Orca recognises its program on screen; an agent
  // that has finished a turn and sits idle reads as a plain terminal there. The per-pane report
  // still knows it, so a terminal is an agent's when either says so.
  const [listed, ps] = await Promise.all([
    cli(['terminal', 'list', `--limit=${LIMIT}`, ...flag]),
    cli(['worktree', 'ps', ...flag]).catch(() => null)
  ])
  const byPane = agentsByPane(ps)
  const terminals = (listed as { terminals?: unknown } | null)?.terminals
  const agents: AgentOption[] = []
  for (const terminal of Array.isArray(terminals) ? terminals : []) {
    if (!terminal || typeof terminal !== 'object') {
      continue
    }
    const { handle, title, agentIdentity, worktreeId, connected, writable, orphaned, tabId, leafId } =
      terminal as Record<string, unknown>
    const terminalId = text(handle)
    const pane = byPane.get(`${tabId}:${leafId}`)
    const agent = text(agentIdentity) ?? pane?.kind ?? (pane ? 'agent' : null)
    // A plain shell has no agent; a terminal Orca cannot write to cannot take a task.
    if (!terminalId || !agent || connected === false || writable === false || orphaned === true) {
      continue
    }
    agents.push({
      terminalId,
      title: text(title) ?? pane?.name ?? agent,
      agent,
      workspaceId: text(worktreeId),
      ...(environment ? { environment } : {})
    })
  }
  return agents
}

/** Every running agent. A paired server that cannot be reached is skipped and reported to `log`. */
export async function listAgents(
  cli: OrcaCli,
  log: (message: string) => void
): Promise<AgentOption[]> {
  const failure = (where: string) => (error: unknown) => {
    log(`could not list agents ${where}: ${error instanceof Error ? error.message : error}`)
    return [] as AgentOption[]
  }
  const environments = await listEnvironments(cli).catch((error: unknown) => {
    log(`could not list paired Orca servers: ${error instanceof Error ? error.message : error}`)
    return [] as Environment[]
  })
  const lists = await Promise.all([
    listRuntimeAgents(cli).catch(failure('on this Orca')),
    ...environments.map((environment) =>
      listRuntimeAgents(cli, environment).catch(failure(`on ${environment.name}`))
    )
  ])
  return lists.flat()
}

/** Submits `prompt` to a running agent, as `orca terminal send --enter` does: pasted, then Enter. */
export async function sendToAgent(
  cli: OrcaCli,
  target: { terminalId: string; environmentId?: string },
  prompt: string
): Promise<void> {
  const args = ['terminal', 'send', `--terminal=${target.terminalId}`]
  if (target.environmentId) {
    args.push(`--environment=${target.environmentId}`)
  }
  // One argument with `=`: a task that starts with `-` is still the text, not a flag.
  await cli([...args, `--text=${prompt}`, '--enter'])
}

/**
 * What the agents of one runtime are doing, by terminal. Orca reports an agent's state by pane
 * (`worktree ps`) and names terminals by handle (`terminal list`); the two meet on the tab and
 * pane ids. A terminal with no reported state is not in the answer.
 */
async function runtimeAgentStates(cli: OrcaCli, environmentId?: string): Promise<Map<string, AgentState>> {
  const flag = environmentId ? [`--environment=${environmentId}`] : []
  const [ps, terminals] = await Promise.all([
    cli(['worktree', 'ps', ...flag]),
    cli(['terminal', 'list', `--limit=${LIMIT}`, ...flag])
  ])
  const byPane = new Map<string, AgentState>()
  for (const worktree of ((ps as { worktrees?: unknown } | null)?.worktrees as unknown[] | undefined) ?? []) {
    for (const agent of ((worktree as { agents?: unknown } | null)?.agents as unknown[] | undefined) ?? []) {
      const { paneKey, state } = (agent ?? {}) as Record<string, unknown>
      if (typeof paneKey === 'string' && (AGENT_STATES as readonly string[]).includes(state as string)) {
        byPane.set(paneKey, state as AgentState)
      }
    }
  }
  const states = new Map<string, AgentState>()
  for (const terminal of ((terminals as { terminals?: unknown } | null)?.terminals as unknown[] | undefined) ?? []) {
    const { handle, tabId, leafId, agentIdentity } = (terminal ?? {}) as Record<string, unknown>
    if (typeof handle !== 'string') {
      continue
    }
    const state = byPane.get(`${tabId}:${leafId}`)
    // A terminal that still runs an agent Orca reports no state for is there, doing nothing new.
    if (state ?? (typeof agentIdentity === 'string' && agentIdentity)) {
      states.set(`${environmentId ?? ''}|${handle}`, state ?? 'waiting')
    }
  }
  return states
}

/**
 * The states of agents on the runtimes named ('' is this Orca), and which of those runtimes
 * answered. One that did not is left out of `reachable`, so its agents are not taken for gone.
 */
export async function agentStates(
  cli: OrcaCli,
  environmentIds: readonly string[],
  log: (message: string) => void
): Promise<{ states: Map<string, AgentState>; reachable: Set<string> }> {
  const states = new Map<string, AgentState>()
  const reachable = new Set<string>()
  await Promise.all(
    environmentIds.map(async (id) => {
      try {
        for (const [key, state] of await runtimeAgentStates(cli, id || undefined)) {
          states.set(key, state)
        }
        reachable.add(id)
      } catch (error) {
        log(`could not read agent states${id ? ` on ${id}` : ''}: ${error instanceof Error ? error.message : error}`)
      }
    })
  )
  return { states, reachable }
}

/** The terminal a CLI answer names, wherever in the answer it sits: a handle starts with `term_`. */
export function terminalIn(answer: unknown): string | undefined {
  if (typeof answer === 'string') {
    return /^term_[\w-]+$/.test(answer) ? answer : undefined
  }
  if (answer && typeof answer === 'object') {
    for (const value of Object.values(answer)) {
      const found = terminalIn(value)
      if (found) {
        return found
      }
    }
  }
  return undefined
}
