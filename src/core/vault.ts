// Keeping the to-dos in step with a folder of Markdown notes, such as a folder in an Obsidian
// vault that Obsidian Sync carries to other machines. Each list is one note:
//
//   ---
//   simple-todo-list: work
//   ---
//   - [ ] Fix the login redirect !high @web #bug due:2026-11-20 %%id:mhx1-k3x9a created:1763550000000%%
//     Notes under the to-do, indented.
//
//   ## Done
//
//   - [x] Ship it %%id:mhx2-b7d1q created:1763540000000 done:1763551000000%%
//
//   ## Archived
//   ...
//
// The `%%…%%` part is an Obsidian comment, hidden when reading, that keeps what the markers do
// not: the to-do's id and its times. A line typed without one is a new to-do.
//
// Both sides can change between two syncs. What was in step at the last sync (the base) says
// which side changed each to-do and each list: a change on one side is taken to the other, and
// when both changed, the plugin's side wins. Only notes that carry `simple-todo-list` in their
// frontmatter are ever read, written or removed. Everything here is pure; the worker does the disk.
import { parseQuickLine, type ListName } from './transfer.ts'
import { listOf, priorityOf } from './todos.ts'
import { DEFAULT_LIST, type Todo } from './types.ts'

/** The frontmatter key that marks a note as a list, and holds the list's id. */
export const LIST_KEY = 'simple-todo-list'

/** A Markdown note in the folder: its file name (`Work.md`) and text. */
export interface VaultFile {
  name: string
  text: string
}

/** What was in step at the last sync. */
export interface VaultBase {
  /** The folder it was in step with; a different folder starts afresh. */
  folder: string
  /** Each to-do as it was in the plugin, and as it was written in its note. */
  todos: Record<string, { todo: string; item: string }>
  /** Each list's title, the note it was written to, and what was written. */
  lists: Record<string, { title: string; file: string; text: string }>
}

export interface VaultSyncInput {
  folder: string
  todos: readonly Todo[]
  lists: readonly ListName[]
  /** Every Markdown note directly in the folder. */
  files: readonly VaultFile[]
  base: VaultBase | null
  newId: () => string
  now: number
  today: string
}

export interface VaultSyncResult {
  todos: Todo[]
  lists: ListName[]
  /** Notes to write, by name. */
  writes: VaultFile[]
  /** Notes to remove, by name. Only ever ones this sync wrote. */
  deletes: string[]
  base: VaultBase
  notes: string[]
}

// --- reading a note --------------------------------------------------------------------------

interface Meta {
  id?: string
  created?: number
  done?: number
  archived?: number
  from?: string
}

export interface VaultItem {
  meta: Meta
  checked: boolean
  /** Under an "Archived" heading. */
  archived: boolean
  /** The first line after the box, without the comment. */
  first: string
  /** The indented lines under it, unindented. */
  body: string
  /** The item as written, to tell whether it changed. */
  block: string
}

export interface ParsedNote {
  /** The list id from the frontmatter; null for a note that is not a list. */
  listId: string | null
  /** Frontmatter lines other than the list key, kept as they are. */
  frontmatter: string[]
  /** Anything before the first to-do, kept as it is. */
  preamble: string
  items: VaultItem[]
}

const ITEM = /^[-*+]\s+(?:\[([ xX])\](?:\s+|$))?(.*)$/
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/
const META = /\s*%%((?:\s*\w+:\S+)*)\s*%%\s*$/

function parseMeta(text: string): Meta {
  const meta: Meta = {}
  for (const token of text.trim().split(/\s+/)) {
    const [key, ...rest] = token.split(':')
    const value = rest.join(':')
    if (!value) {
      continue
    }
    if (key === 'id' || key === 'from') {
      meta[key] = value
    } else if (key === 'created' || key === 'done' || key === 'archived') {
      const time = Number(value)
      if (Number.isFinite(time)) {
        meta[key] = time
      }
    }
  }
  return meta
}

function tidyBlock(lines: readonly string[]): string {
  const tidy = lines.map((line) => line.trimEnd())
  while (tidy.length > 0 && tidy[tidy.length - 1] === '') {
    tidy.pop()
  }
  return tidy.join('\n')
}

export function parseNote(source: string): ParsedNote {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let listId: string | null = null
  const frontmatter: string[] = []
  let index = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const key = new RegExp(`^${LIST_KEY}:\\s*["']?([^"'\\s]+)["']?\\s*$`).exec(line)
        if (key) {
          listId = key[1]
        } else {
          frontmatter.push(line)
        }
      }
      index = end + 1
    }
  }

  const preamble: string[] = []
  const items: VaultItem[] = []
  let archived = false
  let started = false
  let current: { head: string; raw: string[]; body: string[]; checked: boolean } | null = null

  const close = () => {
    if (!current) {
      return
    }
    const comment = META.exec(current.head)
    const first = (comment ? current.head.slice(0, comment.index) : current.head).trim()
    const body = tidyBlock(current.body).replace(/^\n+/, '')
    if (first || body) {
      items.push({
        meta: comment ? parseMeta(comment[1]) : {},
        checked: current.checked,
        archived,
        first,
        body,
        block: tidyBlock(current.raw)
      })
    }
    current = null
  }

  for (const line of lines.slice(index)) {
    const item = ITEM.exec(line)
    const heading = HEADING.exec(line)
    if (item) {
      close()
      started = true
      current = { head: item[2], raw: [line], body: [], checked: item[1] !== undefined && item[1] !== ' ' }
    } else if (current && (/^\s/.test(line) || line === '')) {
      // Indented under a to-do, or a blank line inside one: part of it.
      current.raw.push(line)
      current.body.push(line.replace(/^(\t| {1,2})/, ''))
    } else if (heading && (started || /^(done|archived)$/i.test(heading[1]))) {
      close()
      started = true
      archived = /^archived$/i.test(heading[1])
    } else if (!started) {
      preamble.push(line)
    } else if (line.trim()) {
      // A plain line among the to-dos, as typed on a phone: a to-do of its own.
      close()
      current = { head: line.trim(), raw: [line], body: [], checked: false }
    }
  }
  close()
  return { listId, frontmatter, preamble: tidyBlock(preamble).replace(/^\n+/, ''), items }
}

// --- writing a note --------------------------------------------------------------------------

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n')
}

function markersOf(todo: Todo): string[] {
  const priority = priorityOf(todo)
  return [
    priority === 'none' ? '' : `!${priority}`,
    todo.project ? `@${todo.project.replace(/\s+/g, '-')}` : '',
    ...(todo.tags ?? []).map((tag) => `#${tag}`),
    todo.due ? `due:${todo.due}` : ''
  ].filter(Boolean)
}

/** One to-do as a list item: its first line with the markers and the comment, the rest indented under it. */
export function renderItem(todo: Todo): string {
  const [first, ...rest] = todo.text.split('\n')
  const meta = [
    `id:${todo.id}`,
    `created:${todo.createdAt}`,
    todo.doneAt !== undefined ? `done:${todo.doneAt}` : '',
    todo.archivedAt !== undefined ? `archived:${todo.archivedAt}` : '',
    todo.origin === 'agent' ? 'from:agent' : ''
  ].filter(Boolean)
  const head = [`- [${todo.done ? 'x' : ' '}]`, first.trim(), ...markersOf(todo), `%%${meta.join(' ')}%%`]
    .filter(Boolean)
    .join(' ')
  // Only blank lines go: the body's own indentation (a nested list) is part of it.
  const body = rest.join('\n').replace(/^(\s*\n)+/, '').trimEnd()
  return tidyBlock((body ? `${head}\n${indent(body)}` : head).split('\n'))
}

/** A list's note: the frontmatter and preamble it had, then open, done and archived to-dos. */
export function renderNote(listId: string, todos: readonly Todo[], previous: ParsedNote | null): string {
  const blocks = (pick: (todo: Todo) => boolean) => todos.filter(pick).map(renderItem)
  const open = blocks((todo) => todo.archivedAt === undefined && !todo.done)
  const done = blocks((todo) => todo.archivedAt === undefined && todo.done)
  const archived = blocks((todo) => todo.archivedAt !== undefined)
  const parts = [['---', `${LIST_KEY}: ${listId}`, ...(previous?.frontmatter ?? []), '---'].join('\n')]
  if (previous?.preamble) {
    parts.push(previous.preamble)
  }
  if (open.length > 0) {
    parts.push(open.join('\n'))
  }
  if (done.length > 0) {
    parts.push('## Done', done.join('\n'))
  }
  if (archived.length > 0) {
    parts.push('## Archived', archived.join('\n'))
  }
  return `${parts.join('\n\n')}\n`
}

// --- syncing ---------------------------------------------------------------------------------

/** The fields that travel between machines, in a fixed order. The agent link stays on its machine. */
function canon(todo: Todo): string {
  return JSON.stringify([
    todo.id,
    todo.text,
    todo.done,
    todo.createdAt,
    todo.project ?? null,
    todo.priority ?? null,
    todo.tags ?? null,
    todo.due ?? null,
    todo.doneAt ?? null,
    todo.archivedAt ?? null,
    listOf(todo),
    todo.origin ?? null
  ])
}

function itemKey(list: string, archived: boolean, block: string): string {
  return `${list}\n${archived ? 'archived' : ''}\n${block}`
}

const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g

/** A list title as a file name stem that every system and Obsidian's links accept. */
export function safeName(title: string): string {
  return title.replace(UNSAFE_NAME, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'List'
}

function stemOf(name: string): string {
  return name.replace(/\.md$/i, '')
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

/** A to-do as a note's item says it is, keeping what the note cannot hold from the plugin's copy. */
function fromItem(item: VaultItem, id: string, list: string, previous: Todo | undefined, now: number, today: string): Todo | null {
  const fields = parseQuickLine(item.first, today)
  const text = [fields.text, item.body].filter(Boolean).join('\n')
  if (!text) {
    return null
  }
  // `@My-App` is how "My App" is written: still the same project.
  const project =
    previous?.project && fields.project === previous.project.replace(/\s+/g, '-') ? previous.project : fields.project
  const doneAt = item.checked ? (item.meta.done ?? previous?.doneAt ?? now) : undefined
  const archivedAt = item.archived ? (item.meta.archived ?? previous?.archivedAt ?? now) : undefined
  return {
    id,
    text,
    done: item.checked,
    createdAt: item.meta.created ?? previous?.createdAt ?? now,
    ...(project ? { project } : {}),
    ...(fields.priority ? { priority: fields.priority } : {}),
    ...(fields.tags ? { tags: fields.tags } : {}),
    ...(fields.due ? { due: fields.due } : {}),
    ...(doneAt !== undefined ? { doneAt } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(list !== DEFAULT_LIST ? { list } : {}),
    ...(previous?.agent ? { agent: previous.agent } : {}),
    ...(item.meta.from === 'agent' || previous?.origin === 'agent' ? { origin: 'agent' as const } : {})
  }
}

export function emptyBase(folder: string): VaultBase {
  return { folder, todos: {}, lists: {} }
}

/** What storage holds, as a base: anything malformed is no base at all. */
export function parseBase(stored: unknown): VaultBase | null {
  const raw = stored && typeof stored === 'object' ? (stored as Partial<VaultBase>) : null
  if (!raw || typeof raw.folder !== 'string' || !raw.todos || typeof raw.todos !== 'object' || !raw.lists || typeof raw.lists !== 'object') {
    return null
  }
  return raw as VaultBase
}

export function syncVault(input: VaultSyncInput): VaultSyncResult {
  const { folder, now, today } = input
  const base = input.base && input.base.folder === folder ? input.base : emptyBase(folder)
  const notes: string[] = []

  // The notes that are lists, one per list id.
  const noteOf = new Map<string, { file: VaultFile; note: ParsedNote }>()
  for (const file of [...input.files].sort((a, b) => a.name.localeCompare(b.name))) {
    const note = parseNote(file.text)
    if (!note.listId) {
      continue
    }
    if (noteOf.has(note.listId)) {
      notes.push(`${file.name} is a second note for list ${note.listId}; it is left alone`)
      continue
    }
    noteOf.set(note.listId, { file, note })
  }

  // Lists were written before and none is there now: the folder is likely not what it was
  // (a vault not mounted, a sync half done). Do nothing rather than take that as deleting them all.
  if (noteOf.size === 0 && Object.keys(base.lists).length > 0) {
    return {
      todos: [...input.todos],
      lists: [...input.lists],
      writes: [],
      deletes: [],
      base,
      notes: [...notes, `no list notes in ${folder}, where there were some: not syncing`]
    }
  }

  // --- lists
  const lists: ListName[] = []
  const gone = new Set<string>()
  const deletes: string[] = []
  for (const list of input.lists) {
    const was = base.lists[list.id]
    const found = noteOf.get(list.id)
    if (found) {
      const fileTitle = stemOf(found.file.name)
      // Renamed in the vault, or met for the first time: the note's name is the title.
      const renamedThere = was ? list.title === was.title && found.file.name !== was.file : list.title !== fileTitle
      lists.push(renamedThere ? { id: list.id, title: fileTitle } : list)
    } else if (was && list.title === was.title && list.id !== DEFAULT_LIST) {
      gone.add(list.id)
      notes.push(`list "${list.title}" was removed from the vault`)
    } else {
      lists.push(list)
    }
  }
  const known = new Set(input.lists.map((list) => list.id))
  for (const [id, { file }] of noteOf) {
    if (known.has(id)) {
      continue
    }
    const was = base.lists[id]
    if (was && sameText(file.text, was.text)) {
      // Removed in the plugin, and nobody changed the note since: remove the note too.
      deletes.push(file.name)
      noteOf.delete(id)
    } else {
      lists.push({ id, title: stemOf(file.name) })
    }
  }
  const synced = new Set(lists.map((list) => list.id))

  // --- to-dos
  const inNotes = new Map<string, { item: VaultItem; list: string }>()
  const typed: { item: VaultItem; list: string }[] = []
  for (const [list, { note }] of noteOf) {
    if (!synced.has(list)) {
      continue
    }
    for (const item of note.items) {
      if (!item.meta.id) {
        typed.push({ item, list })
      } else if (!inNotes.has(item.meta.id)) {
        inNotes.set(item.meta.id, { item, list })
      }
    }
  }

  const todos: Todo[] = []
  const have = new Set<string>()
  for (const todo of input.todos) {
    const list = listOf(todo)
    if (gone.has(list)) {
      continue
    }
    have.add(todo.id)
    const was = base.todos[todo.id]
    const found = inNotes.get(todo.id)
    const changedHere = !was || canon(todo) !== was.todo
    if (!synced.has(list)) {
      todos.push(todo)
    } else if (!found) {
      // Not in any note: removed there, unless it changed here since (or is new here).
      if (changedHere) {
        todos.push(todo)
      }
    } else {
      const changedThere = !was || itemKey(found.list, found.item.archived, found.item.block) !== was.item
      if (changedThere && !changedHere) {
        const next = fromItem(found.item, todo.id, found.list, todo, now, today)
        if (next) {
          todos.push(next)
        }
      } else {
        if (changedThere && was) {
          notes.push(`"${todo.text.split('\n')[0]}" changed in both places; kept the plugin's`)
        }
        todos.push(todo)
      }
    }
  }
  for (const [id, { item, list }] of inNotes) {
    if (have.has(id)) {
      continue
    }
    const was = base.todos[id]
    // In the base and unchanged in the note: removed in the plugin.
    if (was && itemKey(list, item.archived, item.block) === was.item) {
      continue
    }
    const todo = fromItem(item, id, list, undefined, now, today)
    if (todo) {
      todos.push(todo)
    }
  }
  typed.forEach(({ item, list }, index) => {
    const todo = fromItem(item, input.newId(), list, undefined, now + index, today)
    if (todo) {
      todos.push(todo)
    }
  })

  // --- the notes, as they now should be
  const writes: VaultFile[] = []
  const next: VaultBase = { folder, todos: {}, lists: {} }
  const taken = new Set(input.files.map((file) => file.name.toLowerCase()))
  for (const list of lists) {
    const found = noteOf.get(list.id)
    const was = base.lists[list.id]
    let name: string
    if (found && ((was && list.title === was.title) || [list.title, safeName(list.title)].includes(stemOf(found.file.name)))) {
      name = found.file.name
    } else {
      const stem = safeName(list.title)
      name = `${stem}.md`
      for (let n = 2; taken.has(name.toLowerCase()) && name !== found?.file.name; n++) {
        name = `${stem} (${n}).md`
      }
      taken.add(name.toLowerCase())
    }
    const own = todos.filter((todo) => listOf(todo) === list.id)
    const text = renderNote(list.id, own, found?.note ?? null)
    if (found && found.file.name !== name) {
      deletes.push(found.file.name)
    }
    if (!found || found.file.name !== name || !sameText(found.file.text, text)) {
      writes.push({ name, text })
    }
    next.lists[list.id] = { title: list.title, file: name, text }
    for (const todo of own) {
      next.todos[todo.id] = { todo: canon(todo), item: itemKey(list.id, todo.archivedAt !== undefined, renderItem(todo)) }
    }
  }

  return { todos, lists, writes, deletes, base: next, notes }
}
