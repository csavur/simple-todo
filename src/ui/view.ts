// The panel's markup, as pure functions from state to HTML strings. Nothing here touches the
// DOM, so every region is unit-tested in Node. Whatever comes from a task or from Orca is
// escaped; controls say what they do with `data-act` (a click) or `data-input` (a value), which
// src/ui/main.ts turns into state changes.
import { escapeHtml, renderMarkdown } from '../core/markdownHtml.ts'
import type { SlashCommand } from '../core/slash.ts'
import {
  dayOf,
  dueLabel,
  dueStatus,
  PRIORITY_LABELS,
  priorityOf,
  tagsOf,
  taskProgress,
  titleOf
} from '../core/todos.ts'
import { DEFAULT_LIST, PRIORITIES, type AgentState, type Priority, type Todo } from '../core/types.ts'
import type { AgentOption } from '../protocol.ts'
import {
  agentKey,
  agentPlace,
  canSend,
  countsOf,
  currentList,
  DEFAULT_TITLE,
  DUE_FILTER_LABELS,
  DUE_FILTERS,
  filterProjects,
  inView,
  isFiltered,
  listTodos,
  MAX_TITLE_LENGTH,
  NEW_AGENT,
  NO_PROJECT,
  projectChoices,
  SORT_LABELS,
  SORTS,
  visibleTodos,
  workspaceKey,
  workspaceLabel,
  workspaceOptions,
  type SendState,
  type Sort,
  type TaskForm,
  type UiState,
  type View
} from './state.ts'

const e = escapeHtml

// Icons, drawn in the outline style of Orca's own (24px grid, 2px round strokes).
const ICONS = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  filter: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  flag: '<path d="M5 21V4M5 4h11l-1.5 4L16 12H5"/>',
  agent:
    '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4.5M9 13v1.5M15 13v1.5M2 13v2M22 13v2"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM14 7l3 3"/>',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
  undo: '<path d="M4 9h10a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9Z"/><circle cx="8.5" cy="8.5" r="1"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  move: '<path d="M4 12h14M13 7l5 5-5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  branch:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-7 2.5-11.5 5.5"/>'
} as const

export type IconName = keyof typeof ICONS

export function icon(name: IconName, className = ''): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

function iconButton(act: string, name: IconName, label: string, extra = ''): string {
  return `<button class="icon-button" type="button" data-act="${act}" title="${e(label)}" aria-label="${e(label)}" ${extra}>${icon(name)}</button>`
}

/** "5m", "3h", "2d", then a date: short, like the ages in Orca's own lists. */
export function ageOf(createdAt: number, now: number): string {
  const minutes = Math.floor((now - createdAt) / 60_000)
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(createdAt).toLocaleDateString()
}

// --- header --------------------------------------------------------------------------------

/** One ticked or unticked line of the filter, like the agent list of the session history. */
function checkItem(act: string, value: string, label: string, on: boolean, lead = ''): string {
  return `<button class="menu-item check-item" type="button" role="menuitemcheckbox" aria-checked="${on}" data-act="${act}" data-value="${e(value)}">
    <span class="tick">${on ? icon('check') : ''}</span>${lead}<span class="grow truncate">${e(label)}</span>
  </button>`
}

function priorityDot(priority: Priority): string {
  return `<span class="dot priority-${priority}"></span>`
}

function filterGroup(title: string, group: string, allOn: boolean, noneOn: boolean, items: string): string {
  return `<div class="menu-head">
      <span class="menu-title">${title}</span>
      <button class="text-button" type="button" data-act="filter-all" data-value="${group}" ${allOn ? 'disabled' : ''}>Select all</button>
      <button class="text-button" type="button" data-act="filter-none" data-value="${group}" ${noneOn ? 'disabled' : ''}>Clear</button>
    </div>${items}`
}

export function filterPopover(state: UiState): string {
  const { hiddenProjects, hiddenPriorities } = state.prefs
  const todos = listTodos(state)
  const projects = filterProjects(todos)
  const shownProjects = projects.filter((name) => !hiddenProjects.includes(name))
  const projectGroup =
    projects.length === 0
      ? ''
      : filterGroup(
          'Projects',
          'projects',
          shownProjects.length === projects.length,
          shownProjects.length === 0,
          projects
            .map((name) =>
              checkItem(
                'filter-project',
                name,
                name === NO_PROJECT ? 'No project' : name,
                !hiddenProjects.includes(name),
                icon('folder', 'lead')
              )
            )
            .join('')
        ) + '<div class="menu-rule"></div>'
  const priorityGroup = filterGroup(
    'Priority',
    'priorities',
    hiddenPriorities.length === 0,
    hiddenPriorities.length === PRIORITIES.length,
    PRIORITIES.map((priority) =>
      checkItem(
        'filter-priority',
        priority,
        PRIORITY_LABELS[priority],
        !hiddenPriorities.includes(priority),
        priorityDot(priority)
      )
    ).join('')
  )
  // Tags work the other way round: nothing ticked shows everything, a tick narrows to that tag.
  const tags = tagsOf(todos)
  const wanted = state.prefs.tags.map((tag) => tag.toLowerCase())
  const tagGroup =
    tags.length === 0
      ? ''
      : `<div class="menu-rule"></div><div class="menu-head"><span class="menu-title">Tags</span>
          <button class="text-button" type="button" data-act="filter-tags-clear" ${wanted.length === 0 ? 'disabled' : ''}>Clear</button></div>${tags
            .map((tag) =>
              checkItem('filter-tag', tag, `#${tag}`, wanted.includes(tag.toLowerCase()), icon('tag', 'lead'))
            )
            .join('')}`
  const dueGroup = `<div class="menu-rule"></div><div class="menu-head"><span class="menu-title">Due</span></div>${DUE_FILTERS.map(
    (due) =>
      `<button class="menu-item check-item" type="button" role="menuitemradio" aria-checked="${state.prefs.due === due}" data-act="filter-due" data-value="${due}"><span class="tick">${state.prefs.due === due ? icon('check') : ''}</span>${icon('calendar', 'lead')}<span class="grow">${DUE_FILTER_LABELS[due]}</span></button>`
  ).join('')}`
  return `<div class="popover filter-popover" role="menu">${projectGroup}${priorityGroup}${tagGroup}${dueGroup}</div>`
}

/** The menu behind the list's name: the lists, and what can be done with this one. */
export function listsPopover(state: UiState): string {
  const current = currentList(state.prefs)
  const openIn = (id: string) =>
    state.todos.filter((todo) => (todo.list ?? DEFAULT_LIST) === id && !todo.done && todo.archivedAt === undefined).length
  const lists = state.prefs.lists
    .map(
      (list) =>
        `<button class="menu-item check-item" type="button" role="menuitemradio" aria-checked="${list.id === current.id}" data-act="list-pick" data-value="${e(list.id)}"><span class="tick">${list.id === current.id ? icon('check') : ''}</span><span class="grow truncate">${e(list.title)}</span><span class="count">${openIn(list.id)}</span></button>`
    )
    .join('')
  const item = (act: string, name: IconName, label: string, className = '') =>
    `<button class="menu-item ${className}" type="button" role="menuitem" data-act="${act}">${icon(name, 'lead')}<span class="grow">${label}</span></button>`
  const remove =
    current.id === DEFAULT_LIST
      ? ''
      : state.confirmList
        ? `<div class="menu-confirm"><span class="grow">Delete "${e(current.title)}" and its to-dos?</span>
            <button class="text-button" type="button" data-act="list-delete-no">Keep</button>
            <button class="text-button danger" type="button" data-act="list-delete-yes">Delete</button></div>`
        : item('list-delete', 'trash', 'Delete this list', 'danger')
  return `<div class="popover lists-popover" role="menu">
    <div class="menu-head"><span class="menu-title">Lists</span></div>
    ${lists}
    ${item('list-new', 'plus', 'New list')}
    <div class="menu-rule"></div>
    ${item('title-edit', 'edit', 'Rename this list')}
    ${item('export-markdown', 'download', 'Export as Markdown')}
    ${item('export-json', 'download', 'Export a backup (JSON)')}
    ${item('import', 'upload', 'Import a file…')}
    ${item('copy-inbox', 'copy', 'Copy instructions for agents')}
    ${remove ? `<div class="menu-rule"></div>${remove}` : ''}
  </div>`
}

export function header(state: UiState, now: number): string {
  const counts = countsOf(listTodos(state), dayOf(now))
  const subtitle = [
    `${counts.open} open`,
    counts.urgent > 0 ? `${counts.urgent} urgent` : '',
    counts.overdue > 0 ? `<span class="overdue">${counts.overdue} overdue</span>` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const filtered = isFiltered(state)
  const filterOpen = state.popover === 'filter'
  const listsOpen = state.popover === 'lists'
  const title = currentList(state.prefs).title
  // A list still called by the default name shows its pencil all the time, as an invitation.
  const unnamed = state.prefs.lists.length === 1 && title === DEFAULT_TITLE
  return `<div class="header">
    <div class="grow">
      ${
        state.renaming
          ? `<input class="title-input" data-input="title" maxlength="${MAX_TITLE_LENGTH}" aria-label="List name" value="${e(title)}" autocomplete="off" spellcheck="false">`
          : `<div class="title-row anchor">
              <button class="title" type="button" data-act="lists-toggle" aria-expanded="${listsOpen}" title="Lists, export and import"><span class="truncate">${e(title)}</span>${icon('chevron', 'title-caret')}</button>
              <button class="title-edit${unnamed ? ' unnamed' : ''}" type="button" data-act="title-edit" title="Rename" aria-label="Rename the list, now &quot;${e(title)}&quot;">${icon('edit')}</button>
              ${listsOpen ? listsPopover(state) : ''}
            </div>`
      }
      <div class="subtitle">${subtitle}</div>
    </div>
    ${iconButton('search-toggle', 'search', state.searching ? 'Close search' : 'Search', `aria-expanded="${state.searching}"`)}
    <div class="anchor">
      ${iconButton('filter-toggle', 'filter', filtered ? 'Filter (active)' : 'Filter', `aria-expanded="${filterOpen}" ${filtered ? 'data-on="true"' : ''}`)}
      ${filterOpen ? filterPopover(state) : ''}
    </div>
    ${iconButton('add-toggle', state.adding ? 'close' : 'plus', state.adding ? 'Close' : 'New to-do')}
  </div>`
}

// --- the summary line: which to-dos, how many, in what order --------------------------------

const VIEW_LABELS: Record<View, string> = { open: 'Open', done: 'Done', all: 'All', archived: 'Archived' }

export function summary(state: UiState, now: number): string {
  const today = dayOf(now)
  const shown = visibleTodos(state, today)
  const archived = state.prefs.view === 'archived'
  const doneShown = archived ? 0 : shown.filter((todo) => todo.done).length
  const sortOpen = state.popover === 'sort'
  const sortItem = (sort: Sort) =>
    `<button class="menu-item check-item" type="button" role="menuitemradio" aria-checked="${state.prefs.sort === sort}" data-act="sort" data-value="${sort}"><span class="tick">${state.prefs.sort === sort ? icon('check') : ''}</span><span class="grow">${SORT_LABELS[sort]}</span></button>`
  const clear = state.confirmClear
    ? `<span class="confirm">Delete ${doneShown} done?
        <button class="text-button" type="button" data-act="clear-no">Keep</button>
        <button class="text-button danger" type="button" data-act="clear-yes">Delete</button></span>`
    : doneShown > 0
      ? `<button class="text-button" type="button" data-act="archive-done" title="Put the done to-dos listed here away">Archive done</button><button class="text-button" type="button" data-act="clear-ask">Clear done</button>`
      : ''
  const counts = countsOf(listTodos(state), today)
  const viewOpen = state.popover === 'view'
  const viewItem = (view: View, count: number) =>
    `<button class="menu-item check-item" type="button" role="menuitemradio" aria-checked="${state.prefs.view === view}" data-act="tab" data-value="${view}"><span class="tick">${state.prefs.view === view ? icon('check') : ''}</span><span class="grow">${VIEW_LABELS[view]}</span><span class="count">${count}</span></button>`
  return `<div class="summary">
    <div class="anchor">
      <button class="view-button" type="button" data-act="view-toggle" aria-expanded="${viewOpen}" aria-label="Show ${VIEW_LABELS[state.prefs.view]} to-dos, ${shown.length} listed">${VIEW_LABELS[state.prefs.view]}<span class="count">${shown.length}</span>${icon('chevron')}</button>
      ${viewOpen ? `<div class="popover view-popover" role="menu">${viewItem('open', counts.open)}${viewItem('done', counts.done)}${viewItem('all', counts.open + counts.done)}<div class="menu-rule"></div>${viewItem('archived', counts.archived)}</div>` : ''}
    </div>
    <span class="grow"></span>
    ${clear}
    <div class="anchor">
      <button class="text-button sort-button" type="button" data-act="sort-toggle" aria-expanded="${sortOpen}">${SORT_LABELS[state.prefs.sort]}${icon('chevron')}</button>
      ${sortOpen ? `<div class="popover sort-popover" role="menu">${SORTS.map(sortItem).join('')}</div>` : ''}
    </div>
  </div>`
}

// --- the task form -------------------------------------------------------------------------

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${e(value)}" ${selected ? 'selected' : ''}>${e(label)}</option>`
}

/** Values of the project select. Real names are prefixed so none can collide with a keyword. */
const OTHER = 'other'
const NO_CHOICE = 'none'
export const PROJECT_PREFIX = 'p:'

// Two lines, to show how a to-do reads best: its first line is drawn as the title. The line
// break is written as a character reference so it survives inside the attribute.
const TEXT_PLACEHOLDER =
  'Title, e.g. Fix the login redirect&#10;Details or a checklist. Type / for formatting.'

/** The inputs of a task, shared by the new-task form and the editor. `scope` keeps their controls apart. */
export function taskForm(state: UiState, form: TaskForm, scope: 'add' | 'edit'): string {
  const choices = projectChoices(state)
  // A stored project that no longer exists anywhere still shows, as itself.
  const names = form.project && !choices.includes(form.project) ? [...choices, form.project] : choices
  const ready = form.text.trim().length > 0
  const body = form.preview
    ? `<div class="preview md">${form.text.trim() ? renderMarkdown(form.text, { readOnly: true }) : '<span class="muted">Nothing to preview.</span>'}</div>`
    : `<textarea class="field textarea" rows="3" data-input="text" data-scope="${scope}" placeholder="${TEXT_PLACEHOLDER}" aria-label="${scope === 'add' ? 'New to-do' : 'Edit to-do'}">${e(form.text)}</textarea>`
  return `<div class="form" data-scope="${scope}">
    ${body}
    <div class="form-row">
      <label class="select-wrap grow">${icon('folder', 'lead')}
        <select class="field select" data-input="project" data-scope="${scope}" aria-label="Project">
          ${option(NO_CHOICE, 'No project', !form.custom && form.project === NO_PROJECT)}
          ${names.map((name) => option(PROJECT_PREFIX + name, name, !form.custom && form.project === name)).join('')}
          ${option(OTHER, 'Other name…', form.custom)}
        </select>${icon('chevron', 'caret')}
      </label>
      <label class="select-wrap grow">${priorityDot(form.priority)}
        <select class="field select" data-input="priority" data-scope="${scope}" aria-label="Priority">
          ${(['none', 'urgent', 'high', 'medium', 'low'] as Priority[]).map((p) => option(p, PRIORITY_LABELS[p], form.priority === p)).join('')}
        </select>${icon('chevron', 'caret')}
      </label>
    </div>
    <div class="form-row">
      <label class="input-wrap grow">${icon('tag', 'lead')}
        <input class="field" data-input="tags" data-scope="${scope}" placeholder="Tags, e.g. bug, idea" aria-label="Tags" autocomplete="off" spellcheck="false" value="${e(form.tags)}">
      </label>
      <label class="input-wrap date-wrap">${icon('calendar', 'lead')}
        <input class="field date${form.due ? '' : ' unset'}" type="date" data-input="due" data-scope="${scope}" aria-label="Due day" value="${e(form.due)}">
      </label>
    </div>
    ${form.custom ? `<input class="field" data-input="customProject" data-scope="${scope}" placeholder="New project name, e.g. website" maxlength="60" aria-label="Project name" value="${e(form.customProject)}">` : ''}
    <div class="form-actions">
      <button class="text-button" type="button" data-act="form-preview" data-scope="${scope}">${form.preview ? 'Write' : 'Preview'}</button>
      <span class="grow"></span>
      <span class="hint">⌘↵</span>
      <button class="button ghost" type="button" data-act="form-cancel" data-scope="${scope}">Cancel</button>
      <button class="button primary" type="button" data-act="form-submit" data-scope="${scope}" ${ready ? '' : 'disabled'}>${scope === 'add' ? 'Add' : 'Save'}</button>
    </div>
  </div>`
}

/** The "/" menu of the task editor: the commands the typed query finds, one of them current. */
export function slashMenu(commands: readonly SlashCommand[], active: number): string {
  if (commands.length === 0) {
    return `<div class="slash-empty">No match</div>`
  }
  return commands
    .map(
      (command, index) =>
        `<button class="menu-item slash-item" type="button" role="option" aria-selected="${index === active}" data-slash="${index}"><span class="glyph">${e(command.glyph)}</span><span class="grow">${e(command.label)}</span><span class="slash-hint">${e(command.hint)}</span></button>`
    )
    .join('')
}

/** The value the project select reports for "Other name…". */
export const OTHER_PROJECT = OTHER

export function composer(state: UiState): string {
  return state.adding ? `<div class="composer">${taskForm(state, state.draft, 'add')}</div>` : ''
}

// --- task rows -----------------------------------------------------------------------------

function menu(state: UiState, todo: Todo): string {
  const jumpable = state.projects.some((project) => project.name === todo.project)
  const item = (act: string, name: IconName, label: string, className = '') =>
    `<button class="menu-item ${className}" type="button" role="menuitem" data-act="${act}" data-id="${e(todo.id)}">${icon(name, 'lead')}<span class="grow">${label}</span></button>`
  if (todo.archivedAt !== undefined) {
    return `<div class="popover row-popover" role="menu">
      ${item('restore', 'undo', 'Restore')}
      <div class="menu-rule"></div>
      ${item('delete', 'trash', 'Delete', 'danger')}
    </div>`
  }
  return `<div class="popover row-popover" role="menu">
    ${item('send', 'agent', 'Send to agent')}
    ${item('edit', 'edit', 'Edit')}
    ${jumpable ? item('jump', 'external', 'Open project') : ''}
    <div class="menu-rule"></div>
    ${item('move-up', 'up', 'Move up')}
    ${item('move-down', 'down', 'Move down')}
    ${state.prefs.lists.length > 1 ? item('move-list', 'move', 'Move to list…') : ''}
    <div class="menu-rule"></div>
    ${item('archive', 'archive', 'Archive')}
    ${item('delete', 'trash', 'Delete', 'danger')}
  </div>`
}

/** Where a task can go: every list but its own. */
function moveSection(state: UiState, todo: Todo): string {
  const own = todo.list ?? DEFAULT_LIST
  return `<div class="section">
    <div class="section-title">Move to list</div>
    <div class="choices">${state.prefs.lists
      .filter((list) => list.id !== own)
      .map(
        (list) =>
          `<button class="choice" type="button" data-act="move-to" data-id="${e(todo.id)}" data-value="${e(list.id)}">${icon('list', 'lead')}<span class="grow truncate">${e(list.title)}</span></button>`
      )
      .join('')}</div>
  </div>`
}

function agentChoice(state: UiState, agent: AgentOption, send: SendState): string {
  const key = agentKey(agent)
  const on = send.target === key
  return `<button class="choice" type="button" role="radio" aria-checked="${on}" data-act="send-target" data-value="${e(key)}">
    <span class="radio"></span>
    <span class="grow"><span class="choice-title truncate">${e(agent.title)}</span><span class="choice-detail truncate">${e(agentPlace(state.projects, agent))}</span></span>
  </button>`
}

function sendSection(state: UiState, todo: Todo, send: SendState, agentKinds: readonly { value: string; label: string }[]): string {
  if (send.agents === null) {
    return `<div class="section"><div class="muted loading">Looking for agents…</div></div>`
  }
  const toNew = send.target === NEW_AGENT
  const workspaces = workspaceOptions(state.projects)
  const newAgent = `<button class="choice" type="button" role="radio" aria-checked="${toNew}" data-act="send-target" data-value="${NEW_AGENT}">
      <span class="radio"></span>
      <span class="grow"><span class="choice-title">A new agent</span><span class="choice-detail">Starts in a workspace you pick</span></span>
    </button>`
  const newFields = !toNew
    ? ''
    : workspaces.length === 0
      ? `<div class="muted">Orca listed no workspace to start an agent in.</div>`
      : `<div class="form-row">
          <label class="select-wrap grow">${icon('agent', 'lead')}
            <select class="field select" data-input="send-agent" aria-label="Agent">
              ${agentKinds.map((kind) => option(kind.value, kind.label, state.prefs.agentKind === kind.value)).join('')}
            </select>${icon('chevron', 'caret')}
          </label>
          <label class="select-wrap grow">${icon('folder', 'lead')}
            <select class="field select" data-input="send-workspace" aria-label="Workspace">
              ${workspaces.map((w) => option(w.value, w.label, send.workspace === w.value)).join('')}
            </select>${icon('chevron', 'caret')}
          </label>
        </div>`
  return `<div class="section">
    <div class="section-title">Send to</div>
    <div class="choices" role="radiogroup">${send.agents.map((agent) => agentChoice(state, agent, send)).join('')}${newAgent}</div>
    ${newFields}
    <div class="form-actions">
      <span class="grow"></span>
      <button class="button ghost" type="button" data-act="row-close">Cancel</button>
      <button class="button primary" type="button" data-act="send-submit" data-id="${e(todo.id)}" ${canSend(state.projects, send) ? '' : 'disabled'}>${send.busy ? 'Sending…' : 'Send'}</button>
    </div>
  </div>`
}

function jumpSection(state: UiState, todo: Todo): string {
  const project = state.projects.find((candidate) => candidate.name === todo.project)
  if (!project) {
    return ''
  }
  return `<div class="section">
    <div class="section-title">Open a workspace of ${e(project.name)}</div>
    <div class="choices">${project.workspaces
      .map(
        (workspace) =>
          `<button class="choice" type="button" data-act="open-workspace" data-value="${e(workspaceKey(workspace))}">${icon(workspace.kind === 'worktree' ? 'branch' : 'folder', 'lead')}<span class="grow truncate">${e(workspaceLabel(workspace))}</span></button>`
      )
      .join('')}</div>
  </div>`
}

function deleteSection(todo: Todo): string {
  return `<div class="section confirm-row">
    <span class="grow">Delete this to-do?</span>
    <button class="button ghost" type="button" data-act="row-close">Keep</button>
    <button class="button danger" type="button" data-act="delete-yes" data-id="${e(todo.id)}">Delete</button>
  </div>`
}

const AGENT_STATE_LABELS: Record<AgentState, string> = {
  working: 'working',
  blocked: 'needs you',
  waiting: 'waiting',
  done: 'finished',
  gone: 'closed'
}

/** A to-do longer than this is folded to a preview until it is opened. */
const FOLD_LINES = 8
const FOLD_CHARS = 480

export function isLong(text: string): boolean {
  return text.split('\n').length > FOLD_LINES || text.length > FOLD_CHARS
}

export function row(
  state: UiState,
  todo: Todo,
  now: number,
  agentKinds: readonly { value: string; label: string }[]
): string {
  const action = state.row?.id === todo.id ? state.row : null
  if (action?.kind === 'edit') {
    return `<li class="row editing priority-${priorityOf(todo)}" data-id="${e(todo.id)}">${taskForm(state, action.form, 'edit')}</li>`
  }
  const today = dayOf(now)
  const title = titleOf(todo)
  const priority = priorityOf(todo)
  const archived = todo.archivedAt !== undefined
  const progress = taskProgress(todo.text)
  const due = todo.due && !todo.done ? dueStatus(todo.due, today) : null
  const agent = todo.agent
  // While an agent is still on it, say what the agent is doing; once it is gone, only that it was sent.
  const agentState = agent?.state && !(agent.state === 'done' && !agent.started) ? agent.state : null
  const meta = [
    priority === 'none'
      ? ''
      : `<span class="meta-item priority-text priority-${priority}">${icon('flag')}${PRIORITY_LABELS[priority]}</span>`,
    todo.due
      ? `<span class="meta-item due${due ? ` due-${due}` : ''}">${icon('calendar')}${todo.done ? e(todo.due) : dueLabel(todo.due, today)}</span>`
      : '',
    progress.total > 0
      ? `<span class="meta-item progress" title="${progress.done} of ${progress.total} done"><span class="bar"><span style="width:${Math.round((progress.done / progress.total) * 100)}%"></span></span>${progress.done}/${progress.total}</span>`
      : '',
    todo.project ? `<span class="meta-item">${icon('folder')}<span class="truncate">${e(todo.project)}</span></span>` : '',
    ...(todo.tags ?? []).map((tag) => `<button class="chip" type="button" data-act="tag" data-value="${e(tag)}" title="Show only #${e(tag)}">#${e(tag)}</button>`),
    agent
      ? `<span class="meta-item agent${agentState ? ` agent-${agentState}` : ''}" title="Sent to ${e(agent.title)}">${icon('agent')}<span class="truncate">${e(agent.title)}</span>${agentState ? `<span class="agent-state">${AGENT_STATE_LABELS[agentState]}</span>` : ''}</span>`
      : '',
    todo.origin === 'agent' ? `<span class="meta-item" title="Added through the agent inbox">${icon('agent')}from an agent</span>` : '',
    `<span class="meta-item">${icon('clock')}${ageOf(todo.createdAt, now)}</span>`
  ].join('')
  const below =
    action?.kind === 'send'
      ? sendSection(state, todo, action.send, agentKinds)
      : action?.kind === 'jump'
        ? jumpSection(state, todo)
        : action?.kind === 'move'
          ? moveSection(state, todo)
          : action?.kind === 'delete'
            ? deleteSection(todo)
            : ''
  const long = isLong(todo.text)
  const folded = long && !state.expanded.includes(todo.id)
  const classes = ['row', `priority-${priority}`, todo.done ? 'done' : '', archived ? 'archived' : '', action ? 'active' : '']
    .filter(Boolean)
    .join(' ')
  return `<li class="${classes}" data-id="${e(todo.id)}">
    ${archived ? '<span class="grip-space"></span>' : `<span class="grip" draggable="true" role="button" tabindex="0" data-drag="${e(todo.id)}" title="Drag to re-order (or focus and press ↑ ↓)" aria-label="Re-order &quot;${e(title)}&quot;: drag, or press the up and down arrow keys">${icon('grip')}</span>`}
    <div class="row-main">
      <div class="md${folded ? ' folded' : ''}">${renderMarkdown(todo.text, { boxId: todo.id, readOnly: archived })}</div>
      ${long ? `<button class="text-button fold-toggle" type="button" data-act="fold" data-id="${e(todo.id)}">${folded ? 'Show more' : 'Show less'}</button>` : ''}
      <div class="meta">${meta}</div>
    </div>
    <div class="row-actions anchor">
      ${archived ? '' : iconButton('done', todo.done ? 'undo' : 'check', `${todo.done ? 'Reopen' : 'Mark done'} "${title}"`, `data-id="${e(todo.id)}"`)}
      ${iconButton('menu', 'more', `Actions for "${title}"`, `data-id="${e(todo.id)}" aria-expanded="${action?.kind === 'menu'}"`)}
      ${action?.kind === 'menu' ? menu(state, todo) : ''}
    </div>
    ${below}
  </li>`
}

const EMPTY: Record<View, { title: string; detail: string }> = {
  open: { title: 'All done', detail: 'Nothing is open.' },
  done: { title: 'Nothing done yet', detail: 'To-dos you finish are listed here.' },
  all: { title: 'No to-dos', detail: 'Press + to add one.' },
  archived: { title: 'Nothing archived', detail: 'Done to-dos you put away are kept here.' }
}

export function list(
  state: UiState,
  now: number,
  agentKinds: readonly { value: string; label: string }[]
): string {
  const shown = visibleTodos(state, dayOf(now))
  if (shown.length > 0) {
    return `<ul class="rows">${shown.map((todo) => row(state, todo, now, agentKinds)).join('')}</ul>`
  }
  const narrowed = inView(state).length > 0
  const nothing = listTodos(state).filter((todo) => todo.archivedAt === undefined).length === 0
  const empty = narrowed ? null : nothing && state.prefs.view !== 'archived' ? EMPTY.all : EMPTY[state.prefs.view]
  return `<div class="empty">
    ${icon(empty ? 'circleCheck' : 'search', 'empty-icon')}
    <div class="empty-title">${empty ? empty.title : 'No match'}</div>
    <div class="empty-detail">${empty ? empty.detail : 'No to-do matches the search and filters.'}</div>
  </div>`
}

export function toast(state: UiState): string {
  if (!state.toast) {
    return ''
  }
  const undo = state.toast.undo ? `<button class="text-button toast-undo" type="button" data-act="undo">Undo</button>` : ''
  return `<div class="toast ${state.toast.tone}" role="status"><span class="grow">${e(state.toast.text)}</span>${undo}${iconButton('toast-close', 'close', 'Dismiss')}</div>`
}
