// Getting the to-dos out of the plugin and back in. JSON is the full-fidelity backup; Markdown
// is for reading and for pasting elsewhere, and a Markdown checklist can be read back as to-dos.
import { cleanTags, listOf, parseTodos, priorityOf } from './todos.ts'
import { DEFAULT_LIST, PRIORITIES, type Priority, type Todo } from './types.ts'

export const EXPORT_FORMAT = 'simple-todo'
export const EXPORT_VERSION = 1

export interface ListName {
  id: string
  title: string
}

/** Everything, as a backup file: every list and every to-do, archived ones included. */
export function exportJson(todos: readonly Todo[], lists: readonly ListName[], now: number): string {
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now, lists, todos }, null, 2)}\n`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n')
}

function markdownItem(todo: Todo): string {
  const [first, ...rest] = todo.text.split('\n')
  const priority = priorityOf(todo)
  const notes = [
    priority === 'none' ? '' : `!${priority}`,
    todo.project ? `@${todo.project.replace(/\s+/g, '-')}` : '',
    ...(todo.tags ?? []).map((tag) => `#${tag}`),
    todo.due ? `due:${todo.due}` : ''
  ].filter(Boolean)
  // The first line carries the markers, so the file reads back as the same to-dos.
  const head = `- [${todo.done ? 'x' : ' '}] ${first.replace(/^#{1,6}\s+/, '')}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`
  const body = rest.join('\n').trim()
  return body ? `${head}\n${indent(body)}` : head
}

/** One list as a Markdown checklist: open to-dos, then done ones. Archived ones are left out. */
export function exportMarkdown(todos: readonly Todo[], list: ListName): string {
  const own = todos.filter((todo) => listOf(todo) === list.id && todo.archivedAt === undefined)
  const open = own.filter((todo) => !todo.done)
  const done = own.filter((todo) => todo.done)
  const lines = [`# ${list.title}`, '']
  if (own.length === 0) {
    lines.push('No to-dos.')
  }
  lines.push(...open.map(markdownItem))
  if (done.length > 0) {
    lines.push('', '## Done', '', ...done.map(markdownItem))
  }
  return `${lines.join('\n')}\n`
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * One line of quick-entry text as the fields of a to-do. Markers anywhere in the line are read
 * and removed: `!urgent` (or high, medium, low), `@project`, `#tag` and `due:YYYY-MM-DD`
 * (or `due:today`, `due:tomorrow`). What is left is the text.
 */
export function parseQuickLine(line: string, today: string): Pick<Todo, 'text' | 'project' | 'priority' | 'tags' | 'due'> {
  let priority: Priority | undefined
  let project: string | undefined
  let due: string | undefined
  const tags: string[] = []
  const words = line.split(/\s+/).filter((word) => {
    const flag = /^!(\w+)$/.exec(word)?.[1].toLowerCase()
    if (flag && flag !== 'none' && (PRIORITIES as readonly string[]).includes(flag)) {
      priority = flag as Priority
      return false
    }
    const at = /^@([\w./-]+)$/.exec(word)?.[1]
    if (at) {
      project = at
      return false
    }
    const tag = /^#([\w-]+)$/.exec(word)?.[1]
    // `#208` is an issue number, not a tag.
    if (tag && !/^\d+$/.test(tag)) {
      tags.push(tag)
      return false
    }
    const day = /^due:(\S+)$/i.exec(word)?.[1].toLowerCase()
    if (day) {
      const resolved = day === 'today' ? today : day === 'tomorrow' ? addDays(today, 1) : day
      if (DAY.test(resolved)) {
        due = resolved
        return false
      }
    }
    return true
  })
  const clean = cleanTags(tags)
  return {
    text: words.join(' ').trim(),
    ...(project ? { project } : {}),
    ...(priority ? { priority } : {}),
    ...(clean.length > 0 ? { tags: clean } : {}),
    ...(due ? { due } : {})
  }
}

export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, date + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

const CHECK_ITEM = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/

/**
 * A Markdown checklist as to-dos: each top-level list item is one, and indented lines under it
 * are the rest of its text. Lines that are not list items (headings, blank lines) are skipped;
 * with no list at all, every non-empty line is a to-do.
 */
export function parseChecklist(source: string, today: string): Omit<Todo, 'id' | 'createdAt'>[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const hasList = lines.some((line) => CHECK_ITEM.test(line))
  const todos: Omit<Todo, 'id' | 'createdAt'>[] = []
  let body: string[] = []
  const closeBody = () => {
    const last = todos[todos.length - 1]
    const text = body.join('\n').trim()
    if (last && text) {
      last.text = `${last.text}\n${text}`
    }
    body = []
  }
  for (const line of lines) {
    const item = CHECK_ITEM.exec(line)
    if (item) {
      closeBody()
      const fields = parseQuickLine(item[2], today)
      if (fields.text) {
        todos.push({ ...fields, done: item[1] !== undefined && item[1] !== ' ' })
      }
    } else if (hasList) {
      // Indented under an item: part of it. Anything else at the margin ends the item.
      if (/^\s+\S/.test(line) && todos.length > 0) {
        body.push(line.replace(/^ {1,2}/, ''))
      } else if (line.trim() && !/^\s/.test(line)) {
        closeBody()
      } else if (body.length > 0) {
        body.push('')
      }
    } else if (line.trim() && !/^#{1,6}\s/.test(line)) {
      const fields = parseQuickLine(line.trim(), today)
      if (fields.text) {
        todos.push({ ...fields, done: false })
      }
    }
  }
  closeBody()
  return todos
}

export interface Imported {
  todos: Todo[]
  /** Lists the file brought that were not here yet. */
  lists: ListName[]
}

/**
 * What an imported file adds. A backup made by this plugin comes back whole (to-dos whose id is
 * already here are skipped, so importing twice adds nothing); anything else is read as a
 * checklist into `list`.
 */
export function importFile(
  source: string,
  existing: readonly Todo[],
  knownLists: readonly ListName[],
  list: string,
  newId: () => string,
  now: number,
  today: string
): Imported {
  type Backup = { format?: unknown; todos?: unknown; lists?: unknown }
  let backup: Backup | null = null
  try {
    const parsed: unknown = JSON.parse(source)
    backup = parsed && typeof parsed === 'object' ? (parsed as Backup) : null
  } catch {
    backup = null
  }
  if (backup && backup.format === EXPORT_FORMAT) {
    const have = new Set(existing.map((todo) => todo.id))
    const lists: ListName[] = []
    for (const item of Array.isArray(backup.lists) ? backup.lists : []) {
      const { id, title } = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      if (typeof id === 'string' && id && typeof title === 'string' && !knownLists.some((l) => l.id === id) && !lists.some((l) => l.id === id)) {
        lists.push({ id, title })
      }
    }
    const valid = new Set([DEFAULT_LIST, ...knownLists.map((l) => l.id), ...lists.map((l) => l.id)])
    const todos = parseTodos(backup.todos)
      .filter((todo) => !have.has(todo.id))
      // A to-do of a list the file does not describe lands in the list being shown.
      .map((todo) => (valid.has(listOf(todo)) ? todo : withList(todo, list)))
    return { todos, lists }
  }
  return {
    todos: parseChecklist(source, today).map((todo, index) =>
      withList({ ...todo, id: newId(), createdAt: now + index, ...(todo.done ? { doneAt: now } : {}) }, list)
    ),
    lists: []
  }
}

function withList(todo: Todo, list: string): Todo {
  const { list: _list, ...rest } = todo
  return list === DEFAULT_LIST ? rest : { ...rest, list }
}

/** What agents are told: how to add a to-do by appending a line to the inbox file. */
export function inboxInstructions(path: string): string {
  return [
    `To add a to-do to my Simple Todo list in Orca, append one line per to-do to the file ${path}`,
    '(create it if it does not exist). Each line is a Markdown list item:',
    '',
    '- [ ] Text of the to-do !high @project-name #tag due:2026-01-31',
    '',
    'The markers are optional: !urgent, !high, !medium or !low for priority, @name for the project,',
    '#name for tags, and due:YYYY-MM-DD (or due:today, due:tomorrow) for the due day.',
    'The file is read and emptied within a few seconds. Do not edit lines that are already there.'
  ].join('\n')
}
