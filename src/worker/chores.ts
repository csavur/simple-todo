// What the worker does on its own, between requests: remind of due days, put old done to-dos
// away, follow the agents to-dos were sent to, and take in what agents left in the inbox. Each
// is a pure function over the list here; src/worker.ts runs them on a timer and stores the result.
import { parseChecklist } from '../core/transfer.ts'
import { titleOf, withDone } from '../core/todos.ts'
import { DEFAULT_LIST, type AgentState, type Todo } from '../core/types.ts'

export interface Settings {
  /** Text put before a to-do when it is sent to an agent. */
  promptPrefix: string
  /** Mark a to-do done when the agent it was sent to finishes. */
  autoComplete: boolean
  /** Archive done to-dos after this many days; 0 never does. */
  archiveAfterDays: number
  /** Show a desktop notification when a to-do becomes due. */
  dueReminders: boolean
  /** Keep the agent skill installed, so agents know how to add to-dos. */
  agentSkill: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  promptPrefix: '',
  autoComplete: false,
  archiveAfterDays: 14,
  dueReminders: true,
  agentSkill: true
}

export function parseSettings(stored: Record<string, unknown>): Settings {
  const days = stored.archiveAfterDays
  return {
    promptPrefix: typeof stored.promptPrefix === 'string' ? stored.promptPrefix : DEFAULT_SETTINGS.promptPrefix,
    autoComplete: stored.autoComplete === true,
    archiveAfterDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_SETTINGS.archiveAfterDays,
    dueReminders: stored.dueReminders !== false,
    agentSkill: stored.agentSkill !== false
  }
}

/** A to-do as the prompt an agent gets: the prefix from the settings, a blank line, the text. */
export function promptOf(text: string, settings: Settings): string {
  const prefix = settings.promptPrefix.trim()
  return prefix ? `${prefix}\n\n${text}` : text
}

// --- due reminders -------------------------------------------------------------------------

export interface Reminder {
  title: string
  body: string
}

/** Which due day each to-do was last reminded of, by id. */
export type Reminded = Record<string, string>

/**
 * The reminder to show now, if any: for open to-dos that are due today or overdue and have not
 * been reminded of that due day yet. One notification covers them all. Also answers the record
 * to store, with entries of to-dos that no longer need one dropped.
 */
export function dueReminder(
  todos: readonly Todo[],
  reminded: Reminded,
  today: string
): { reminder: Reminder | null; reminded: Reminded } {
  const pending = todos.filter((todo) => !todo.done && todo.archivedAt === undefined && todo.due !== undefined && todo.due <= today)
  const fresh = pending.filter((todo) => reminded[todo.id] !== todo.due)
  const next: Reminded = {}
  for (const todo of pending) {
    next[todo.id] = todo.due as string
  }
  if (fresh.length === 0) {
    return { reminder: null, reminded: next }
  }
  const overdue = fresh.filter((todo) => (todo.due as string) < today).length
  const kind = overdue === fresh.length ? 'overdue' : overdue === 0 ? 'due today' : 'due'
  const reminder =
    fresh.length === 1
      ? { title: overdue === 1 ? 'To-do overdue' : 'To-do due today', body: titleOf(fresh[0]) }
      : {
          title: `${fresh.length} to-dos ${kind}`,
          body: fresh
            .slice(0, 4)
            .map((todo) => titleOf(todo))
            .join('\n')
        }
  return { reminder, reminded: next }
}

// --- archiving -----------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** Archives to-dos done more than `days` ago. Answers the same array when nothing changes. */
export function autoArchive(todos: readonly Todo[], days: number, now: number): readonly Todo[] {
  if (days <= 0) {
    return todos
  }
  const cutoff = now - days * DAY_MS
  const due = (todo: Todo) =>
    todo.done && todo.archivedAt === undefined && todo.doneAt !== undefined && todo.doneAt <= cutoff
  return todos.some(due) ? todos.map((todo) => (due(todo) ? { ...todo, archivedAt: now } : todo)) : todos
}

// --- agents --------------------------------------------------------------------------------

export function agentLinkKey(link: { terminalId: string; environmentId?: string }): string {
  return `${link.environmentId ?? ''}|${link.terminalId}`
}

/** To-dos whose agent is still worth asking about. */
export function linkedTodos(todos: readonly Todo[]): Todo[] {
  return todos.filter(
    (todo) => todo.agent !== undefined && !todo.done && todo.archivedAt === undefined && todo.agent.state !== 'gone'
  )
}

/**
 * Brings each linked to-do up to date with what its agent is doing. `states` holds every agent
 * found; `reachable` names the runtimes that answered ('' is this Orca), so an agent on a
 * server that could not be asked keeps its last state instead of reading as gone. With
 * `autoComplete`, a to-do whose agent worked and then finished is marked done.
 * Answers the same array when nothing changes.
 */
export function applyAgentStates(
  todos: readonly Todo[],
  states: ReadonlyMap<string, AgentState>,
  reachable: ReadonlySet<string>,
  autoComplete: boolean,
  now: number
): readonly Todo[] {
  let changed = false
  const next = todos.map((todo) => {
    const link = todo.agent
    if (!link || todo.done || todo.archivedAt !== undefined || link.state === 'gone') {
      return todo
    }
    if (!reachable.has(link.environmentId ?? '')) {
      return todo
    }
    const state = states.get(agentLinkKey(link)) ?? 'gone'
    // Idle when it got the to-do reads as `done`; only work seen since then counts as starting.
    const started = link.started === true || state === 'working' || state === 'blocked'
    if (state === link.state && started === (link.started === true)) {
      return todo
    }
    changed = true
    const linked: Todo = { ...todo, agent: { ...link, state, ...(started ? { started: true } : {}) } }
    return autoComplete && started && state === 'done' ? withDone(linked, true, now) : linked
  })
  return changed ? next : todos
}

// --- the inbox -----------------------------------------------------------------------------

/** The to-dos an inbox file holds, for `list`. Anything that is not a to-do line is ignored. */
export function inboxTodos(source: string, list: string, newId: () => string, now: number, today: string): Todo[] {
  return parseChecklist(source, today).map((todo, index) => ({
    ...todo,
    id: newId(),
    createdAt: now + index,
    ...(todo.done ? { doneAt: now } : {}),
    ...(list !== DEFAULT_LIST ? { list } : {}),
    origin: 'agent' as const
  }))
}
