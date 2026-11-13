// What the panel knows and the pure rules over it: which tasks show, in what order, what a
// form stands for. No DOM and no Orca here, so every rule is unit-tested in Node.
import {
  cleanTags,
  daysBetween,
  listOf,
  priorityOf,
  projectsOf,
  sortByPriority,
  tagsOf,
  withDone
} from '../core/todos.ts'
import { DEFAULT_LIST, PRIORITIES, type Priority, type Todo } from '../core/types.ts'
import type { AgentOption, OrcaProject, OrcaWorkspace, WorkspaceRef } from '../protocol.ts'

/** `archived` lists what was put away: out of the other three, still searchable here. */
export type View = 'open' | 'done' | 'all' | 'archived'
export const VIEWS: readonly View[] = ['open', 'done', 'all', 'archived']

/** `manual` is the order the person dragged the tasks into: the order they are stored in. */
export type Sort = 'manual' | 'priority' | 'due' | 'newest' | 'oldest'
export const SORTS: readonly Sort[] = ['manual', 'priority', 'due', 'newest', 'oldest']
export const SORT_LABELS: Record<Sort, string> = {
  manual: 'Manual',
  priority: 'Priority',
  due: 'Due date',
  newest: 'Newest',
  oldest: 'Oldest'
}

/** The filter's name for tasks without a project. */
export const NO_PROJECT = ''

/** What the person chose and expects to find again after a restart. */
export const DEFAULT_TITLE = 'Simple Todo'
export const MAX_TITLE_LENGTH = 40

/** A title as stored: trimmed, within the limit, and never empty. */
export function cleanTitle(typed: string, fallback: string = DEFAULT_TITLE): string {
  return typed.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH).trim() || fallback
}

/** A named list of to-dos. The first one always has the id `DEFAULT_LIST`. */
export interface TodoList {
  id: string
  title: string
}

/** Which due days are listed. `week` is today and the seven days after it, overdue included. */
export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'none'
export const DUE_FILTERS: readonly DueFilter[] = ['any', 'overdue', 'today', 'week', 'none']
export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
  any: 'Any time',
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due within a week',
  none: 'No due date'
}

/** What the person chose and expects to find again after a restart. */
export interface Prefs {
  /** Every list, in the order they were made. Never empty. */
  lists: TodoList[]
  /** The list being shown. */
  list: string
  view: View
  sort: Sort
  /** Projects ticked off in the filter. Hidden ones are stored, so a new project shows by default. */
  hiddenProjects: string[]
  hiddenPriorities: Priority[]
  /** Tags to show: a to-do with any of them is listed. Empty means no tag filter. */
  tags: string[]
  due: DueFilter
  /** The agent last launched, offered first next time. */
  agentKind: string
}

export const DEFAULT_PREFS: Prefs = {
  lists: [{ id: DEFAULT_LIST, title: DEFAULT_TITLE }],
  list: DEFAULT_LIST,
  view: 'open',
  sort: 'priority',
  hiddenProjects: [],
  hiddenPriorities: [],
  tags: [],
  due: 'any',
  agentKind: 'claude'
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseLists(raw: Record<string, unknown>): TodoList[] {
  const lists: TodoList[] = []
  for (const item of Array.isArray(raw.lists) ? raw.lists : []) {
    const { id, title } = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (typeof id === 'string' && id && !lists.some((list) => list.id === id)) {
      lists.push({ id, title: cleanTitle(typeof title === 'string' ? title : '') })
    }
  }
  if (!lists.some((list) => list.id === DEFAULT_LIST)) {
    // Before there were several lists, the one list's name was stored as `title`.
    lists.unshift({ id: DEFAULT_LIST, title: cleanTitle(typeof raw.title === 'string' ? raw.title : '') })
  }
  return lists
}

/** What storage holds, as preferences: anything malformed falls back to its default. */
export function parsePrefs(stored: unknown): Prefs {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const lists = parseLists(raw)
  return {
    lists,
    list: lists.some((list) => list.id === raw.list) ? (raw.list as string) : lists[0].id,
    view: VIEWS.includes(raw.view as View) ? (raw.view as View) : DEFAULT_PREFS.view,
    sort: SORTS.includes(raw.sort as Sort) ? (raw.sort as Sort) : DEFAULT_PREFS.sort,
    hiddenProjects: strings(raw.hiddenProjects),
    hiddenPriorities: strings(raw.hiddenPriorities).filter((p): p is Priority =>
      (PRIORITIES as readonly string[]).includes(p)
    ),
    tags: strings(raw.tags),
    due: DUE_FILTERS.includes(raw.due as DueFilter) ? (raw.due as DueFilter) : DEFAULT_PREFS.due,
    agentKind: typeof raw.agentKind === 'string' && raw.agentKind ? raw.agentKind : DEFAULT_PREFS.agentKind
  }
}

export function currentList(prefs: Prefs): TodoList {
  return prefs.lists.find((list) => list.id === prefs.list) ?? prefs.lists[0]
}

export function addList(prefs: Prefs, id: string, title: string): Prefs {
  return { ...prefs, lists: [...prefs.lists, { id, title: cleanTitle(title, 'New list') }], list: id }
}

export function renameList(prefs: Prefs, id: string, title: string): Prefs {
  return {
    ...prefs,
    lists: prefs.lists.map((list) => (list.id === id ? { ...list, title: cleanTitle(title, list.title) } : list))
  }
}

/** Removes a list and shows the first one. The first list can never be removed. */
export function removeList(prefs: Prefs, id: string): Prefs {
  if (id === DEFAULT_LIST || !prefs.lists.some((list) => list.id === id)) {
    return prefs
  }
  const lists = prefs.lists.filter((list) => list.id !== id)
  return { ...prefs, lists, list: prefs.list === id ? lists[0].id : prefs.list }
}

/** The fields of a task while it is being written or edited. */
export interface TaskForm {
  /** The task being edited; absent while writing a new one. */
  id?: string
  text: string
  /** A project name, or NO_PROJECT. Ignored while `custom` is on. */
  project: string
  /** Whether the project is a name typed by hand (`customProject`). */
  custom: boolean
  customProject: string
  priority: Priority
  /** Tags as typed: separated by commas or spaces, with or without `#`. */
  tags: string
  /** `YYYY-MM-DD`, or empty for no due day. */
  due: string
  preview: boolean
}

export const EMPTY_FORM: TaskForm = {
  text: '',
  project: NO_PROJECT,
  custom: false,
  customProject: '',
  priority: 'none',
  tags: '',
  due: '',
  preview: false
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function parseDraft(stored: unknown): TaskForm {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    project: typeof raw.project === 'string' ? raw.project : NO_PROJECT,
    custom: raw.custom === true,
    customProject: typeof raw.customProject === 'string' ? raw.customProject : '',
    priority: (PRIORITIES as readonly string[]).includes(raw.priority as string)
      ? (raw.priority as Priority)
      : 'none',
    tags: typeof raw.tags === 'string' ? raw.tags : '',
    due: typeof raw.due === 'string' && DAY.test(raw.due) ? raw.due : '',
    preview: false
  }
}

export function formOf(todo: Todo): TaskForm {
  return {
    ...EMPTY_FORM,
    id: todo.id,
    text: todo.text,
    project: todo.project ?? NO_PROJECT,
    priority: priorityOf(todo),
    tags: (todo.tags ?? []).join(', '),
    due: todo.due ?? ''
  }
}

type FormFields = Pick<Todo, 'text' | 'project' | 'priority' | 'tags' | 'due'>

/** The stored fields a form stands for; absent ones are left out rather than stored empty. */
export function fieldsOf(form: TaskForm): FormFields {
  const project = (form.custom ? form.customProject : form.project).trim()
  const tags = cleanTags(form.tags.split(/[\s,]+/))
  return {
    text: form.text.trim(),
    ...(project ? { project } : {}),
    ...(form.priority !== 'none' ? { priority: form.priority } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(DAY.test(form.due) ? { due: form.due } : {})
  }
}

export const NEW_AGENT = 'new'

export interface SendState {
  /** null while the worker is asked. */
  agents: AgentOption[] | null
  /** NEW_AGENT or an `agentKey`. */
  target: string
  /** The `workspaceKey` of where a new agent starts; empty when there is none to offer. */
  workspace: string
  busy: boolean
}

/** What is open under one task. One task at a time, and one thing under it. */
export type RowAction =
  | { kind: 'menu' | 'delete' | 'jump' | 'move'; id: string }
  | { kind: 'edit'; id: string; form: TaskForm }
  | { kind: 'send'; id: string; send: SendState }

export interface Toast {
  tone: 'success' | 'danger' | 'neutral'
  text: string
  /** The list as it was before what the message reports, when that can be taken back. */
  undo?: Todo[]
}

export interface UiState {
  /** Every to-do, of every list. */
  todos: Todo[]
  prefs: Prefs
  search: string
  /** Whether the list's title is being renamed in place. */
  renaming: boolean
  /** Whether the search box is showing; the header's search icon opens it. */
  searching: boolean
  /** Orca's projects, here and on paired servers. */
  projects: OrcaProject[]
  /** The form for a new task, when the header's + opened it. */
  adding: boolean
  draft: TaskForm
  row: RowAction | null
  popover: 'filter' | 'sort' | 'view' | 'lists' | null
  confirmClear: boolean
  /** Whether the list menu is asking before deleting the list. */
  confirmList: boolean
  /** Long to-dos shown in full. */
  expanded: string[]
  toast: Toast | null
}

export function initialState(): UiState {
  return {
    todos: [],
    prefs: DEFAULT_PREFS,
    search: '',
    renaming: false,
    searching: false,
    projects: [],
    adding: false,
    draft: EMPTY_FORM,
    row: null,
    popover: null,
    confirmClear: false,
    confirmList: false,
    expanded: [],
    toast: null
  }
}

// --- the task list -------------------------------------------------------------------------

export function addTodo(
  todos: readonly Todo[],
  form: TaskForm,
  id: string,
  now: number,
  list: string = DEFAULT_LIST
): Todo[] {
  const fields = fieldsOf(form)
  if (!fields.text) {
    return [...todos]
  }
  return [
    ...todos,
    { id, done: false, createdAt: now, ...fields, ...(list !== DEFAULT_LIST ? { list } : {}) }
  ]
}

/** Replaces what a form edits; a field the form leaves empty is removed. The rest of the task stays. */
export function updateTodo(todos: readonly Todo[], id: string, form: TaskForm): Todo[] {
  const fields = fieldsOf(form)
  if (!fields.text) {
    return [...todos]
  }
  return todos.map((todo) => {
    if (todo.id !== id) {
      return todo
    }
    const { text: _text, project: _project, priority: _priority, tags: _tags, due: _due, ...kept } = todo
    return { ...kept, ...fields }
  })
}

export function setDone(todos: readonly Todo[], id: string, done: boolean, now: number): Todo[] {
  return todos.map((todo) => (todo.id === id ? withDone(todo, done, now) : todo))
}

/** Puts tasks away, or brings them back when `at` is null. */
export function setArchived(todos: readonly Todo[], ids: readonly string[], at: number | null): Todo[] {
  const chosen = new Set(ids)
  return todos.map((todo) => {
    if (!chosen.has(todo.id)) {
      return todo
    }
    const { archivedAt: _archivedAt, ...rest } = todo
    return at === null ? rest : { ...rest, archivedAt: at }
  })
}

/** Moves a task to another list. */
export function setList(todos: readonly Todo[], id: string, list: string): Todo[] {
  return todos.map((todo) => {
    if (todo.id !== id) {
      return todo
    }
    const { list: _list, ...rest } = todo
    return list === DEFAULT_LIST ? rest : { ...rest, list }
  })
}

export function patchTodo(todos: readonly Todo[], id: string, patch: Partial<Todo>): Todo[] {
  return todos.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo))
}

export function removeTodos(todos: readonly Todo[], ids: readonly string[]): Todo[] {
  const gone = new Set(ids)
  return todos.filter((todo) => !gone.has(todo.id))
}

// --- what shows ----------------------------------------------------------------------------

export interface Counts {
  open: number
  done: number
  urgent: number
  overdue: number
  archived: number
}

/** The to-dos of the list being shown. */
export function listTodos(state: Pick<UiState, 'todos' | 'prefs'>): Todo[] {
  return state.todos.filter((todo) => listOf(todo) === state.prefs.list)
}

export function countsOf(todos: readonly Todo[], today: string): Counts {
  const live = todos.filter((todo) => todo.archivedAt === undefined)
  const open = live.filter((todo) => !todo.done)
  return {
    open: open.length,
    done: live.length - open.length,
    urgent: open.filter((todo) => priorityOf(todo) === 'urgent').length,
    overdue: open.filter((todo) => todo.due !== undefined && todo.due < today).length,
    archived: todos.length - live.length
  }
}

/** Every name a task can be tagged with: Orca's projects plus names typed by hand. */
export function projectChoices(state: Pick<UiState, 'todos' | 'projects'>): string[] {
  return [...new Set([...state.projects.map((project) => project.name), ...projectsOf(state.todos)])].sort(
    (a, b) => a.localeCompare(b)
  )
}

/** The projects worth filtering by: those that have tasks, then NO_PROJECT when any task is untagged. */
export function filterProjects(todos: readonly Todo[]): string[] {
  const names = projectsOf(todos)
  return todos.some((todo) => !todo.project) ? [...names, NO_PROJECT] : names
}

/** Whether a filter hides anything that exists. A hidden project or tag with no tasks left hides nothing. */
export function isFiltered(state: Pick<UiState, 'todos' | 'prefs'>): boolean {
  const todos = listTodos(state)
  const projects = filterProjects(todos)
  const tags = tagsOf(todos).map((tag) => tag.toLowerCase())
  return (
    state.prefs.hiddenProjects.some((name) => projects.includes(name)) ||
    state.prefs.hiddenPriorities.length > 0 ||
    state.prefs.tags.some((tag) => tags.includes(tag.toLowerCase())) ||
    state.prefs.due !== 'any'
  )
}

function matchesSearch(todo: Todo, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, '')
  return (
    !needle ||
    todo.text.toLowerCase().includes(needle) ||
    (todo.project ?? '').toLowerCase().includes(needle) ||
    (todo.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  )
}

function matchesDue(todo: Todo, filter: DueFilter, today: string): boolean {
  if (filter === 'any') {
    return true
  }
  if (filter === 'none') {
    return todo.due === undefined
  }
  if (todo.due === undefined) {
    return false
  }
  const days = daysBetween(today, todo.due)
  return filter === 'overdue' ? days < 0 : filter === 'today' ? days === 0 : days <= 7
}

function sorted(todos: readonly Todo[], sort: Sort): Todo[] {
  if (sort === 'manual') {
    return [...todos]
  }
  if (sort === 'priority') {
    return sortByPriority(todos)
  }
  if (sort === 'due') {
    // Soonest first; a task without a day comes after every task that has one.
    const byPriority = sortByPriority(todos)
    return byPriority.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  }
  const direction = sort === 'newest' ? -1 : 1
  return [...todos].sort((a, b) => direction * (a.createdAt - b.createdAt))
}

/** The tasks of the current list and tab, before the filter and search apply. */
export function inView(state: Pick<UiState, 'todos' | 'prefs'>): Todo[] {
  const { view } = state.prefs
  return listTodos(state).filter((todo) => {
    if (view === 'archived') {
      return todo.archivedAt !== undefined
    }
    if (todo.archivedAt !== undefined) {
      return false
    }
    return view === 'all' ? true : view === 'done' ? todo.done : !todo.done
  })
}

/** The tasks listed, in order. Done tasks follow the open ones. */
export function visibleTodos(state: Pick<UiState, 'todos' | 'prefs' | 'search'>, today: string): Todo[] {
  const { prefs } = state
  const tags = prefs.tags.map((tag) => tag.toLowerCase())
  const known = tagsOf(listTodos(state)).map((tag) => tag.toLowerCase())
  // A stored tag that no task carries any more filters nothing.
  const wanted = tags.filter((tag) => known.includes(tag))
  const kept = inView(state).filter(
    (todo) =>
      !prefs.hiddenProjects.includes(todo.project ?? NO_PROJECT) &&
      !prefs.hiddenPriorities.includes(priorityOf(todo)) &&
      (wanted.length === 0 || (todo.tags ?? []).some((tag) => wanted.includes(tag.toLowerCase()))) &&
      matchesDue(todo, prefs.due, today) &&
      matchesSearch(todo, state.search)
  )
  return [
    ...sorted(kept.filter((todo) => !todo.done), prefs.sort),
    ...sorted(kept.filter((todo) => todo.done), prefs.sort)
  ]
}

/**
 * Moves a task to just before or after another, among the tasks listed (`shown`, in the order
 * they are drawn). The listed tasks trade places within the slots they already hold in the
 * stored list, so tasks that a filter, the search or the tab hides stay exactly where they are.
 * Returns the list unchanged when the move makes no sense or changes nothing.
 */
export function moveTodo(
  todos: readonly Todo[],
  shown: readonly Todo[],
  movedId: string,
  targetId: string,
  place: 'before' | 'after'
): Todo[] {
  const moved = shown.find((todo) => todo.id === movedId)
  const target = shown.find((todo) => todo.id === targetId)
  // Open and done tasks are listed apart, so a task only moves among its own kind.
  if (!moved || !target || moved.id === target.id || moved.done !== target.done) {
    return [...todos]
  }
  const order = shown.filter((todo) => todo.id !== movedId)
  order.splice(order.findIndex((todo) => todo.id === targetId) + (place === 'after' ? 1 : 0), 0, moved)
  const shownIds = new Set(shown.map((todo) => todo.id))
  const next = order[Symbol.iterator]()
  return todos.map((todo) => (shownIds.has(todo.id) ? (next.next().value as Todo) : todo))
}

/** Moves a task one place up or down among the listed tasks of its kind. */
export function nudgeTodo(
  todos: readonly Todo[],
  shown: readonly Todo[],
  id: string,
  direction: 'up' | 'down'
): Todo[] {
  const moved = shown.find((todo) => todo.id === id)
  const peers = shown.filter((todo) => todo.done === moved?.done)
  const neighbour = peers[peers.findIndex((todo) => todo.id === id) + (direction === 'up' ? -1 : 1)]
  return moved && neighbour
    ? moveTodo(todos, shown, id, neighbour.id, direction === 'up' ? 'before' : 'after')
    : [...todos]
}

/** Ticks one entry of a hidden list on or off. */
export function toggled<T>(hidden: readonly T[], value: T): T[] {
  return hidden.includes(value) ? hidden.filter((item) => item !== value) : [...hidden, value]
}

// --- workspaces and agents -----------------------------------------------------------------

/** Unique across this Orca and every paired server. */
export function workspaceKey(workspace: OrcaWorkspace): string {
  return `${workspace.environment?.id ?? ''}|${workspace.id}`
}

export function workspaceRef(workspace: OrcaWorkspace): WorkspaceRef {
  return {
    workspaceId: workspace.id,
    ...(workspace.environment ? { environmentId: workspace.environment.id } : {})
  }
}

export function workspaceLabel(workspace: OrcaWorkspace): string {
  // A worktree is often named after its branch: say it once.
  const name =
    workspace.branch && workspace.branch !== workspace.name
      ? `${workspace.name} (${workspace.branch})`
      : workspace.name
  return workspace.environment ? `${name} on ${workspace.environment.name}` : name
}

export function findWorkspace(projects: readonly OrcaProject[], key: string): OrcaWorkspace | undefined {
  return projects.flatMap((project) => project.workspaces).find((w) => workspaceKey(w) === key)
}

/** Every workspace an agent can start in, named by project. */
export function workspaceOptions(projects: readonly OrcaProject[]): { value: string; label: string }[] {
  return projects.flatMap((project) =>
    project.workspaces.map((workspace) => ({
      value: workspaceKey(workspace),
      label:
        project.name === workspace.name
          ? workspaceLabel(workspace)
          : `${project.name} / ${workspaceLabel(workspace)}`
    }))
  )
}

export function agentKey(agent: AgentOption): string {
  return `${agent.environment?.id ?? ''}|${agent.terminalId}`
}

function sameHost(agent: AgentOption, workspace: OrcaWorkspace): boolean {
  return (agent.environment?.id ?? '') === (workspace.environment?.id ?? '')
}

export function projectOfAgent(projects: readonly OrcaProject[], agent: AgentOption): OrcaProject | undefined {
  return projects.find((project) =>
    project.workspaces.some((w) => w.id === agent.workspaceId && sameHost(agent, w))
  )
}

/** Where an agent runs, for the line under its title. */
export function agentPlace(projects: readonly OrcaProject[], agent: AgentOption): string {
  const project = projectOfAgent(projects, agent)
  const workspace = project?.workspaces.find((w) => w.id === agent.workspaceId && sameHost(agent, w))
  const where = !project
    ? null
    : workspace && workspace.name !== project.name
      ? `${project.name} / ${workspace.name}`
      : project.name
  return [agent.agent, where, agent.environment?.name].filter(Boolean).join(' · ')
}

/** Agents already working in the task's project first: they are the likeliest target. */
export function agentsFor(
  projects: readonly OrcaProject[],
  agents: readonly AgentOption[],
  todo: Todo
): AgentOption[] {
  const rank = (agent: AgentOption) => (projectOfAgent(projects, agent)?.name === todo.project ? 0 : 1)
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => rank(a.agent) - rank(b.agent) || a.index - b.index)
    .map(({ agent }) => agent)
}

/** Where sending a task starts: the first running agent, else a new one in the task's project. */
export function startSend(projects: readonly OrcaProject[], todo: Todo): SendState {
  const own = projects.find((project) => project.name === todo.project)
  const first = (own ?? projects[0])?.workspaces[0]
  return { agents: null, target: NEW_AGENT, workspace: first ? workspaceKey(first) : '', busy: false }
}

export function withAgents(
  projects: readonly OrcaProject[],
  send: SendState,
  agents: readonly AgentOption[],
  todo: Todo
): SendState {
  const ordered = agentsFor(projects, agents, todo)
  return { ...send, agents: ordered, target: ordered.length > 0 ? agentKey(ordered[0]) : NEW_AGENT }
}

/** Whether the send form names somewhere the task can go. */
export function canSend(projects: readonly OrcaProject[], send: SendState): boolean {
  if (send.busy || send.agents === null) {
    return false
  }
  return send.target === NEW_AGENT
    ? findWorkspace(projects, send.workspace) !== undefined
    : send.agents.some((agent) => agentKey(agent) === send.target)
}
