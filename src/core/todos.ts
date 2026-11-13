// Pure functions over the task list, shared by the panel and the worker.
import {
  AGENT_STATES,
  DEFAULT_LIST,
  PRIORITIES,
  type AgentLink,
  type AgentState,
  type Priority,
  type Todo
} from './types.ts'

const MAX_TITLE_LENGTH = 60

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority'
}

export function priorityOf(todo: Todo): Priority {
  return todo.priority ?? 'none'
}

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function parseAgent(value: unknown): AgentLink | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const { terminalId, environmentId, title, sentAt, state, started } = value as Record<string, unknown>
  if (typeof terminalId !== 'string' || !terminalId) {
    return undefined
  }
  return {
    terminalId,
    ...(typeof environmentId === 'string' && environmentId ? { environmentId } : {}),
    title: typeof title === 'string' && title ? title : 'Agent',
    sentAt: typeof sentAt === 'number' ? sentAt : 0,
    ...((AGENT_STATES as readonly string[]).includes(state as string) ? { state: state as AgentState } : {}),
    ...(started === true ? { started: true } : {})
  }
}

/** Tags as stored: no `#`, no blanks, no repeats, in the order given. */
export function cleanTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const tag of tags) {
    const name = typeof tag === 'string' ? tag.trim().replace(/^#+/, '').replace(/[\s,]+/g, '-') : ''
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase())
      clean.push(name)
    }
  }
  return clean
}

/** What storage holds, as a task list: anything malformed is dropped rather than trusted. */
export function parseTodos(stored: unknown): Todo[] {
  if (!Array.isArray(stored)) {
    return []
  }
  const todos: Todo[] = []
  for (const item of stored) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.text !== 'string') {
      continue
    }
    const tags = Array.isArray(raw.tags) ? cleanTags(raw.tags) : []
    const agent = parseAgent(raw.agent)
    todos.push({
      id: raw.id,
      // An "@" mention feature, since removed, wrote `[@Title](agent:...)` into to-dos: read as `@Title`.
      text: raw.text.replace(/\[@([^\]\n]+)\]\(agent:[^)\s]*\)/g, '@$1'),
      done: raw.done === true,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      ...(typeof raw.project === 'string' && raw.project ? { project: raw.project } : {}),
      ...(isPriority(raw.priority) && raw.priority !== 'none' ? { priority: raw.priority } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(typeof raw.due === 'string' && DAY.test(raw.due) ? { due: raw.due } : {}),
      ...(typeof raw.doneAt === 'number' ? { doneAt: raw.doneAt } : {}),
      ...(typeof raw.archivedAt === 'number' ? { archivedAt: raw.archivedAt } : {}),
      ...(typeof raw.list === 'string' && raw.list && raw.list !== DEFAULT_LIST ? { list: raw.list } : {}),
      ...(agent ? { agent } : {}),
      ...(raw.origin === 'agent' ? { origin: 'agent' as const } : {})
    })
  }
  return todos
}

export function listOf(todo: Todo): string {
  return todo.list ?? DEFAULT_LIST
}

/** Marks a task done or open again, keeping when it was finished. */
export function withDone(todo: Todo, done: boolean, now: number): Todo {
  const { doneAt: _doneAt, ...rest } = todo
  return done ? { ...rest, done: true, doneAt: now } : { ...rest, done: false }
}

// --- days ----------------------------------------------------------------------------------

/** The local day of a moment, as `YYYY-MM-DD`. */
export function dayOf(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const at = (day: string) => {
    const [year, month, date] = day.split('-').map(Number)
    return Date.UTC(year, month - 1, date)
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

export type DueStatus = 'overdue' | 'today' | 'soon' | 'later'

/** How pressing a due day is, seen from `today`. `soon` is within a week. */
export function dueStatus(due: string, today: string): DueStatus {
  const days = daysBetween(today, due)
  return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 7 ? 'soon' : 'later'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A due day as people say it: "Today", "Tomorrow", "Fri", "Mar 3", "2d overdue". */
export function dueLabel(due: string, today: string): string {
  const days = daysBetween(today, due)
  if (days < 0) {
    return `${-days}d overdue`
  }
  if (days === 0) {
    return 'Today'
  }
  if (days === 1) {
    return 'Tomorrow'
  }
  const [year, month, date] = due.split('-').map(Number)
  if (days <= 6) {
    return WEEKDAYS[new Date(year, month - 1, date).getDay()]
  }
  const sameYear = due.slice(0, 4) === today.slice(0, 4)
  return `${MONTHS[month - 1]} ${date}${sameYear ? '' : `, ${year}`}`
}

// --- task boxes ----------------------------------------------------------------------------

/** How many of a task's `- [ ]` boxes are ticked. Boxes inside a code block do not count. */
export function taskProgress(text: string): { done: number; total: number } {
  let done = 0
  let total = 0
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    const box = fenced ? null : /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(line)
    if (box) {
      total++
      if (box[1] !== ' ') {
        done++
      }
    }
  }
  return { done, total }
}

/** Every tag in use, sorted. */
export function tagsOf(todos: readonly Todo[]): string[] {
  const names = new Map<string, string>()
  for (const todo of todos) {
    for (const tag of todo.tags ?? []) {
      if (!names.has(tag.toLowerCase())) {
        names.set(tag.toLowerCase(), tag)
      }
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}

/** Most pressing first, then oldest first. */
export function sortByPriority(todos: readonly Todo[]): Todo[] {
  const rank = (todo: Todo) => PRIORITIES.indexOf(priorityOf(todo))
  return [...todos].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
}

/** The names tasks are tagged with, sorted. */
export function projectsOf(todos: readonly Todo[]): string[] {
  const names = new Set<string>()
  for (const todo of todos) {
    if (todo.project) {
      names.add(todo.project)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** A one-line plain name for a task: its first line of text, without Markdown markers. */
export function titleOf(todo: Todo): string {
  const firstLine =
    todo.text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const plain = firstLine
    .replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+)/, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return plain.length > MAX_TITLE_LENGTH ? `${plain.slice(0, MAX_TITLE_LENGTH - 3)}...` : plain
}

export interface StatusBarState {
  visible: boolean
  text: string
  tone: 'neutral' | 'danger'
  tooltip: string
}

/** What the status bar item shows. Hidden when nothing is open. Archived tasks never count. */
export function statusBarOf(todos: readonly Todo[], today?: string): StatusBarState {
  const open = todos.filter((todo) => !todo.done && todo.archivedAt === undefined)
  const urgent = open.filter((todo) => priorityOf(todo) === 'urgent').length
  const overdue = today ? open.filter((todo) => todo.due && todo.due < today).length : 0
  if (open.length === 0) {
    return { visible: false, text: '', tone: 'neutral', tooltip: 'No open to-dos' }
  }
  const parts = [`${open.length} ${open.length === 1 ? 'to-do' : 'to-dos'}`]
  if (urgent > 0) {
    parts.push(`${urgent} urgent`)
  }
  if (overdue > 0) {
    parts.push(`${overdue} overdue`)
  }
  return {
    visible: true,
    text: parts.join(', '),
    tone: urgent > 0 || overdue > 0 ? 'danger' : 'neutral',
    tooltip: `Next: ${titleOf(sortByPriority(open)[0])}`
  }
}

const SUMMARY_LIMIT = 10

/** The open tasks as plain text, most pressing first, for the palette command. */
export function summaryOf(todos: readonly Todo[]): string {
  const open = sortByPriority(todos.filter((todo) => !todo.done && todo.archivedAt === undefined))
  if (open.length === 0) {
    return 'No open to-dos.'
  }
  const lines = open.slice(0, SUMMARY_LIMIT).map((todo) => {
    const priority = priorityOf(todo)
    const flag = priority === 'none' ? '' : `[${PRIORITY_LABELS[priority]}] `
    const project = todo.project ? ` (${todo.project})` : ''
    return `- ${flag}${titleOf(todo)}${project}`
  })
  if (open.length > SUMMARY_LIMIT) {
    lines.push(`...and ${open.length - SUMMARY_LIMIT} more`)
  }
  return lines.join('\n')
}
