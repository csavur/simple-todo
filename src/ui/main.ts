// The panel's one script with side effects: it holds the state, draws the regions of
// panel/index.html from src/ui/view.ts, turns clicks and typing into state changes, and talks to
// Orca (storage, the plugin's worker). The rules live in src/ui/state.ts.
import { completeTaskBox, continueList } from '../core/markdown.ts'
import { toggleTaskBox } from '../core/markdownHtml.ts'
import { applySlash, matchSlash, slashQuery } from '../core/slash.ts'
import { dayOf, parseTodos } from '../core/todos.ts'
import { exportJson, exportMarkdown, importFile, inboxInstructions } from '../core/transfer.ts'
import { DEFAULT_LIST, PRIORITIES, TODOS_KEY, type Priority, type Todo } from '../core/types.ts'
import type { Outcome } from '../protocol.ts'
import {
  addList,
  addTodo,
  agentKey,
  canSend,
  currentList,
  EMPTY_FORM,
  filterProjects,
  findWorkspace,
  formOf,
  initialState,
  listTodos,
  moveTodo,
  NEW_AGENT,
  NO_PROJECT,
  nudgeTodo,
  parseDraft,
  parsePrefs,
  patchTodo,
  removeList,
  removeTodos,
  renameList,
  setArchived,
  setDone,
  setList,
  startSend,
  toggled,
  updateTodo,
  visibleTodos,
  withAgents,
  workspaceRef,
  type DueFilter,
  type Prefs,
  type Sort,
  type TaskForm,
  type UiState,
  type View
} from './state.ts'
import { composer, header, list, PROJECT_PREFIX, slashMenu, summary, toast } from './view.ts'

const PREFS_KEY = 'prefs'
const DRAFT_KEY = 'draft'
const DRAFT_SAVE_MS = 400
const TOAST_MS = 4000
/** A message that offers Undo stays longer: long enough to notice a mistake. */
const UNDO_MS = 9000
const AGE_REFRESH_MS = 60_000

/** Agents Orca can launch, by the id `agent.launch` takes. */
const AGENT_KINDS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'amp', label: 'Amp' },
  { value: 'aider', label: 'Aider' },
  { value: 'goose', label: 'Goose' }
] as const

type Region = 'header' | 'composer' | 'summary' | 'list' | 'toast'
const ALL_REGIONS: readonly Region[] = ['header', 'composer', 'summary', 'list', 'toast']

const state: UiState = initialState()

function region(name: Region): HTMLElement {
  return document.getElementById(name) as HTMLElement
}

function grow(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight + 2}px`
}

/**
 * Redraws regions from the state. Whatever is being typed into survives: the field that had
 * focus gets it back with its caret, since a region is replaced whole.
 */
function render(regions: readonly Region[] = ALL_REGIONS): void {
  const focused = document.activeElement as HTMLElement | null
  const focusKey = focused?.dataset?.input ? `${focused.dataset.input}|${focused.dataset.scope ?? ''}` : null
  const caret =
    focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
      ? [focused.selectionStart, focused.selectionEnd]
      : null

  // The "/" menu belongs to a text box that a redraw may replace.
  closeMenu()
  const now = Date.now()
  for (const name of regions) {
    region(name).innerHTML =
      name === 'header'
        ? header(state, now)
        : name === 'composer'
          ? composer(state)
          : name === 'summary'
            ? summary(state, now)
            : name === 'list'
              ? list(state, now, AGENT_KINDS)
              : toast(state)
  }
  document.querySelectorAll<HTMLTextAreaElement>('textarea.textarea').forEach(grow)

  if (focusKey && !document.activeElement?.matches('[data-input]')) {
    const [input, scope] = focusKey.split('|')
    const again = [...document.querySelectorAll<HTMLElement>(`[data-input="${input}"]`)].find(
      (element) => (element.dataset.scope ?? '') === scope
    )
    again?.focus()
    if (caret && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)) {
      try {
        again.setSelectionRange(caret[0], caret[1])
      } catch {
        // Not every input type has a caret.
      }
    }
  }
}

function focusField(input: string, scope: string): void {
  const field = [...document.querySelectorAll<HTMLElement>(`[data-input="${input}"]`)].find(
    (element) => (element.dataset.scope ?? '') === scope
  )
  field?.focus()
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    field.setSelectionRange(field.value.length, field.value.length)
  }
}

// --- the "/" menu --------------------------------------------------------------------------

// The menu under the text box being typed in: the commands after a "/".
// It lives outside the state: it follows each keystroke, and typing never redraws a form.
let caretMenu: {
  field: HTMLTextAreaElement
  element: HTMLElement
  active: number
  /** How many entries can be picked. */
  count: number
  draw: (active: number) => string
  pick: (index: number) => void
} | null = null

function closeMenu(): void {
  caretMenu?.element.remove()
  caretMenu = null
}

function drawMenu(): void {
  if (caretMenu) {
    caretMenu.element.innerHTML = caretMenu.draw(caretMenu.active)
    caretMenu.element.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
}

function showMenu(
  field: HTMLTextAreaElement,
  count: number,
  draw: (active: number) => string,
  pick: (index: number) => void
): void {
  let element = caretMenu?.field === field ? caretMenu.element : null
  if (!element) {
    closeMenu()
    element = document.createElement('div')
    element.className = 'popover slash-popover'
    element.setAttribute('role', 'listbox')
    field.closest('.form')?.append(element)
  }
  element.style.top = `${field.offsetTop + field.offsetHeight + 4}px`
  caretMenu = { field, element, active: 0, count, draw, pick }
  drawMenu()
}

/** Puts text the menu wrote into the text box, with the caret or selection where it belongs. */
function writeText(field: HTMLTextAreaElement, text: string, start: number, end: number): void {
  closeMenu()
  field.value = text
  field.focus()
  field.setSelectionRange(start, end)
  syncText(field)
}

/** Opens, narrows or closes the menu to match what is typed at the caret. */
function updateMenu(field: HTMLTextAreaElement): void {
  const caret = field.selectionStart
  if (field.selectionEnd !== caret) {
    return closeMenu()
  }
  const slash = slashQuery(field.value, caret)
  if (slash) {
    const commands = matchSlash(slash.query)
    // Typing on past anything that matches means it was not a command after all.
    if (commands.length === 0 && slash.query.length > 2) {
      return closeMenu()
    }
    return showMenu(
      field,
      commands.length,
      (active) => slashMenu(commands, active),
      (index) => {
        const result = applySlash(field.value, slash, field.selectionStart, commands[index])
        writeText(field, result.text, result.selectionStart, result.selectionEnd)
      }
    )
  }
  closeMenu()
}

/** Takes a text box's value into its form after the script changed it. */
function syncText(field: HTMLTextAreaElement): void {
  changeForm(field.dataset.scope ?? '', { text: field.value })
  grow(field)
  const submit = field.closest('.form')?.querySelector<HTMLButtonElement>('[data-act="form-submit"]')
  if (submit) {
    submit.disabled = !field.value.trim()
  }
}

// A press, not a click: the text box must keep its focus and caret.
document.addEventListener('mousedown', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-slash]')
  if (item && caretMenu) {
    event.preventDefault()
    caretMenu.pick(Number(item.dataset.slash))
  }
})

document.addEventListener('focusout', (event) => {
  if (caretMenu && event.target === caretMenu.field) {
    closeMenu()
  }
})

// --- talking to Orca -----------------------------------------------------------------------

function report(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
/** Shows a message. With `undo` (the list as it was), it offers to take the change back. */
function showToast(tone: 'success' | 'danger' | 'neutral', text: string, undo?: Todo[]): void {
  clearTimeout(toastTimer)
  state.toast = { tone, text, ...(undo ? { undo } : {}) }
  render(['toast'])
  // A failure stays until dismissed; anything else needs no answer.
  if (tone !== 'danger') {
    toastTimer = setTimeout(
      () => {
        state.toast = null
        render(['toast'])
      },
      undo ? UNDO_MS : TOAST_MS
    )
  }
}

function today(): string {
  return dayOf(Date.now())
}

/** The to-dos listed right now, in order. */
function shownTodos(): Todo[] {
  return visibleTodos(state, today())
}

function save(key: string, value: unknown): void {
  orca.storage.set(key, value as never).catch((error: unknown) => {
    showToast('danger', `Could not save: ${report(error)}`)
  })
}

function setTodos(todos: Todo[]): void {
  state.todos = todos
  save(TODOS_KEY, todos)
}

function setPrefs(patch: Partial<Prefs>): void {
  state.prefs = { ...state.prefs, ...patch }
  save(PREFS_KEY, state.prefs)
}

let draftTimer: ReturnType<typeof setTimeout> | undefined
function saveDraftSoon(): void {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => save(DRAFT_KEY, state.draft), DRAFT_SAVE_MS)
}

/** Asks the worker, turning a rejection (no worker, a timeout) into the same shape as a failure. */
async function ask<T extends object>(request: Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await request
  } catch (error) {
    return { ok: false, error: report(error) }
  }
}

async function loadProjects(): Promise<void> {
  const outcome = await ask(orca.plugin.request('projects.list'))
  // A failure keeps the last known projects: tags still work without them.
  if (outcome.ok) {
    state.projects = outcome.projects
    render(['composer', 'list'])
  }
}

// --- forms ---------------------------------------------------------------------------------

function formIn(scope: string): TaskForm | null {
  if (scope === 'add') {
    return state.draft
  }
  return state.row?.kind === 'edit' ? state.row.form : null
}

function changeForm(scope: string, patch: Partial<TaskForm>): void {
  if (scope === 'add') {
    state.draft = { ...state.draft, ...patch }
    saveDraftSoon()
  } else if (state.row?.kind === 'edit') {
    state.row = { ...state.row, form: { ...state.row.form, ...patch } }
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function submitForm(scope: string): void {
  const form = formIn(scope)
  if (!form || !form.text.trim()) {
    return
  }
  if (scope === 'add') {
    setTodos(addTodo(state.todos, form, newId(), Date.now(), state.prefs.list))
    // Keep the project, so the next to-do for the same project is one step shorter.
    const project = (form.custom ? form.customProject : form.project).trim()
    state.draft = { ...EMPTY_FORM, project }
    save(DRAFT_KEY, state.draft)
    state.adding = false
  } else if (form.id) {
    setTodos(updateTodo(state.todos, form.id, form))
    state.row = null
  }
  render()
}

function closeForm(scope: string): void {
  if (scope === 'add') {
    state.adding = false
  } else {
    state.row = null
  }
  render(['header', 'composer', 'list'])
}

// --- sending to agents and opening workspaces ----------------------------------------------

function todoOf(id: string | undefined): Todo | undefined {
  return state.todos.find((todo) => todo.id === id)
}

async function openSend(todo: Todo): Promise<void> {
  state.row = { kind: 'send', id: todo.id, send: startSend(state.projects, todo) }
  render(['list'])
  // Workspaces on a paired server come and go without an event: refresh for the next time.
  void loadProjects()
  const outcome = await ask(orca.plugin.request('agents.list'))
  // The person may have closed it or opened another to-do's while the worker answered.
  if (state.row?.kind !== 'send' || state.row.id !== todo.id) {
    return
  }
  state.row = {
    ...state.row,
    send: withAgents(state.projects, state.row.send, outcome.ok ? outcome.agents : [], todo)
  }
  render(['list'])
}

async function submitSend(todo: Todo): Promise<void> {
  if (state.row?.kind !== 'send' || !canSend(state.projects, state.row.send)) {
    return
  }
  const send = state.row.send
  state.row = { ...state.row, send: { ...send, busy: true } }
  render(['list'])

  const toNew = send.target === NEW_AGENT
  const workspace = findWorkspace(state.projects, send.workspace)
  const agent = send.agents?.find((candidate) => agentKey(candidate) === send.target)
  const outcome: Outcome<{ terminalId?: string }> =
    toNew && workspace
      ? await ask(
          orca.plugin.request('agent.launch', {
            ...workspaceRef(workspace),
            agent: state.prefs.agentKind,
            prompt: todo.text
          })
        )
      : agent
        ? await ask(
            orca.plugin.request('agent.send', {
              terminalId: agent.terminalId,
              ...(agent.environment ? { environmentId: agent.environment.id } : {}),
              prompt: todo.text
            })
          )
        : { ok: false, error: 'That agent is no longer listed.' }

  const stillOpen = state.row?.kind === 'send' && state.row.id === todo.id
  if (!outcome.ok) {
    if (state.row?.kind === 'send' && stillOpen) {
      // Left open, so another agent can be picked.
      state.row = { ...state.row, send: { ...state.row.send, busy: false } }
      render(['list'])
    }
    showToast('danger', `Could not send the to-do: ${outcome.error}`)
    return
  }
  // Remember who has it, so the card can show what that agent is doing.
  const terminalId = toNew ? outcome.terminalId : agent?.terminalId
  const environmentId = toNew ? workspace?.environment?.id : agent?.environment?.id
  if (terminalId) {
    const kind = AGENT_KINDS.find((candidate) => candidate.value === state.prefs.agentKind)
    setTodos(
      patchTodo(state.todos, todo.id, {
        agent: {
          terminalId,
          ...(environmentId ? { environmentId } : {}),
          title: toNew ? (kind?.label ?? state.prefs.agentKind) : (agent?.title ?? 'Agent'),
          sentAt: Date.now()
        }
      })
    )
  }
  if (stillOpen) {
    state.row = null
  }
  render(['list'])
  showToast('success', toNew ? 'Started a new agent with the to-do.' : 'Sent the to-do to the agent.')
}

async function openWorkspace(key: string): Promise<void> {
  const workspace = findWorkspace(state.projects, key)
  if (!workspace) {
    return
  }
  state.row = null
  render(['list'])
  const outcome = await ask(orca.plugin.request('workspace.open', workspaceRef(workspace)))
  if (!outcome.ok) {
    showToast('danger', `Could not open ${workspace.name}: ${outcome.error}`)
  }
}

function jump(todo: Todo): void {
  const project = state.projects.find((candidate) => candidate.name === todo.project)
  if (!project) {
    return
  }
  if (project.workspaces.length === 1) {
    void openWorkspace(`${project.workspaces[0].environment?.id ?? ''}|${project.workspaces[0].id}`)
  } else {
    state.row = { kind: 'jump', id: todo.id }
    render(['list'])
  }
}

// --- re-ordering ---------------------------------------------------------------------------

/** Stores a new order and lists by it: a hand-made order means nothing under another sort. */
function reorder(next: Todo[]): void {
  state.row = null
  if (next.some((todo, index) => todo.id !== state.todos[index]?.id)) {
    setTodos(next)
    setPrefs({ sort: 'manual' })
  }
  render(['summary', 'list'])
}

function gripOf(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-drag]')].find((grip) => grip.dataset.drag === id)
}

/** Moves a to-do one place from its handle with the arrow keys, keeping the handle focused. */
function nudgeFromGrip(id: string, direction: 'up' | 'down'): void {
  reorder(nudgeTodo(state.todos, shownTodos(), id, direction))
  const grip = gripOf(id)
  grip?.focus()
  grip?.closest('.row')?.scrollIntoView({ block: 'nearest' })
}

let dragged: string | null = null

function clearDropMarks(): void {
  document.body.classList.remove('is-dragging')
  document
    .querySelectorAll('.drop-before, .drop-after, .dragging')
    .forEach((row) => row.classList.remove('drop-before', 'drop-after', 'dragging'))
}

/** The row under the pointer and which half of it, when the dragged task may land there. */
function dropPlace(event: DragEvent): { row: HTMLElement; place: 'before' | 'after' } | null {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-id]')
  if (!dragged || !row || row.dataset.id === dragged) {
    return null
  }
  const from = todoOf(dragged)
  const onto = todoOf(row.dataset.id)
  if (!from || !onto || from.done !== onto.done) {
    return null
  }
  const box = row.getBoundingClientRect()
  return { row, place: event.clientY < box.top + box.height / 2 ? 'before' : 'after' }
}

document.addEventListener('dragstart', (event) => {
  const grip = (event.target as HTMLElement).closest<HTMLElement>('[data-drag]')
  const row = grip?.closest<HTMLElement>('.row')
  if (!grip || !row || !event.dataTransfer) {
    return
  }
  dragged = grip.dataset.drag ?? null
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', dragged ?? '')
  // The whole card follows the pointer, held where it was grabbed.
  const box = row.getBoundingClientRect()
  event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top)
  // After the browser has taken its picture of the card, so the picture is not dimmed.
  requestAnimationFrame(() => {
    row.classList.add('dragging')
    document.body.classList.add('is-dragging')
  })
})

document.addEventListener('dragover', (event) => {
  const drop = dropPlace(event)
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((row) => row.classList.remove('drop-before', 'drop-after'))
  if (drop && event.dataTransfer) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    drop.row.classList.add(drop.place === 'before' ? 'drop-before' : 'drop-after')
  }
})

document.addEventListener('drop', (event) => {
  const drop = dropPlace(event)
  const id = dragged
  dragged = null
  clearDropMarks()
  if (drop && id && drop.row.dataset.id) {
    event.preventDefault()
    reorder(moveTodo(state.todos, shownTodos(), id, drop.row.dataset.id, drop.place))
  }
})

document.addEventListener('dragend', () => {
  dragged = null
  clearDropMarks()
})

// --- renaming the list ---------------------------------------------------------------------

/** Keeps the rename box as wide as its text where the browser cannot size it from CSS alone. */
function fitTitle(input: HTMLInputElement): void {
  if (!CSS.supports('field-sizing', 'content')) {
    input.style.width = `calc(${Math.max(input.value.length, 6) + 1}ch + 14px)`
  }
}

function startRename(): void {
  state.renaming = true
  state.popover = null
  render(['header', 'summary'])
  const input = document.querySelector<HTMLInputElement>('[data-input="title"]')
  if (input) {
    fitTitle(input)
    input.focus()
    input.select()
  }
}

/** Ends renaming, keeping what was typed unless it was cancelled. */
function endRename(keep: boolean): void {
  if (!state.renaming) {
    return
  }
  const input = document.querySelector<HTMLInputElement>('[data-input="title"]')
  // Cleared first: redrawing the header blurs the text box, which would end the rename twice.
  state.renaming = false
  if (keep && input) {
    const next = renameList(state.prefs, state.prefs.list, input.value)
    if (currentList(next).title !== currentList(state.prefs).title) {
      setPrefs(next)
    }
  }
  render(['header'])
}

// --- lists, export and import --------------------------------------------------------------

function pickList(id: string): void {
  setPrefs({ list: id })
  state.popover = null
  state.row = null
  state.confirmClear = false
  render()
}

function newList(): void {
  setPrefs(addList(state.prefs, `l${newId()}`, 'New list'))
  state.row = null
  // Named straight away: a list called "New list" is not what anyone wants.
  startRename()
  render(['summary', 'list'])
  const input = document.querySelector<HTMLInputElement>('[data-input="title"]')
  input?.focus()
  input?.select()
}

function deleteCurrentList(): void {
  const id = state.prefs.list
  state.confirmList = false
  state.popover = null
  setTodos(state.todos.filter((todo) => (todo.list ?? DEFAULT_LIST) !== id))
  setPrefs(removeList(state.prefs, id))
  render()
}

/** Offers text as a file to save. Orca shows its save dialog; the plugin never learns the path. */
function saveFile(name: string, mimeType: string, data: string): void {
  state.popover = null
  render(['header'])
  if (!orca.files) {
    return showToast('danger', 'This Orca cannot save files from a plugin.')
  }
  orca.files
    .saveAs({ suggestedName: name, mimeType, data })
    .then((result) => {
      if (result.status === 'saved') {
        showToast('success', `Saved ${name}.`)
      }
    })
    .catch((error: unknown) => showToast('danger', `Could not save: ${report(error)}`))
}

function fileName(title: string, extension: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'to-dos'
  return `${base}.${extension}`
}

function importText(source: string): void {
  const before = state.todos
  const imported = importFile(source, before, state.prefs.lists, state.prefs.list, newId, Date.now(), today())
  if (imported.todos.length === 0) {
    return showToast('neutral', 'Nothing new in that file.')
  }
  if (imported.lists.length > 0) {
    setPrefs({ lists: [...state.prefs.lists, ...imported.lists] })
  }
  setTodos([...before, ...imported.todos])
  render()
  const count = imported.todos.length
  showToast('success', `Imported ${count} ${count === 1 ? 'to-do' : 'to-dos'}.`, before)
}

document.getElementById('import-file')?.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared, so choosing the same file again is still a change.
  input.value = ''
  if (file) {
    file
      .text()
      .then(importText)
      .catch((error: unknown) => showToast('danger', `Could not read the file: ${report(error)}`))
  }
})

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The frame may not be allowed the clipboard API; the older way works from a click.
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

async function copyInboxInstructions(): Promise<void> {
  state.popover = null
  render(['header'])
  try {
    const { path } = await orca.plugin.request('inbox.path')
    const copied = await copyText(inboxInstructions(path))
    showToast(copied ? 'success' : 'danger', copied ? 'Copied. Paste it to an agent.' : 'Could not copy to the clipboard.')
  } catch (error) {
    showToast('danger', `Could not copy: ${report(error)}`)
  }
}

/** Opens the form for a new to-do, ready to type in. */
function openComposer(): void {
  state.adding = true
  state.popover = null
  render(['header', 'composer'])
  focusField('text', 'add')
}

document.addEventListener('focusout', (event) => {
  if ((event.target as HTMLElement).dataset?.input === 'title') {
    endRename(true)
  }
})

// --- search --------------------------------------------------------------------------------

/** Shows or hides the search box. Closing it also clears the search: a hidden box must not keep narrowing the list. */
function setSearching(on: boolean): void {
  const input = document.getElementById('search') as HTMLInputElement
  state.searching = on
  state.popover = null
  if (!on) {
    state.search = ''
    input.value = ''
  }
  ;(document.getElementById('toolbar') as HTMLElement).hidden = !on
  render(['header', 'summary', 'list'])
  if (on) {
    input.focus()
  }
}

// --- clicks --------------------------------------------------------------------------------

function onAct(act: string, target: HTMLElement): void {
  const value = target.dataset.value ?? ''
  const scope = target.dataset.scope ?? ''
  const todo = todoOf(target.dataset.id)

  switch (act) {
    case 'add-toggle':
      if (!state.adding) {
        return openComposer()
      }
      state.adding = false
      state.popover = null
      return render(['header', 'composer'])
    case 'title-edit':
      return startRename()
    case 'lists-toggle':
      state.popover = state.popover === 'lists' ? null : 'lists'
      state.confirmList = false
      return render(['header', 'summary'])
    case 'list-pick':
      return pickList(value)
    case 'list-new':
      return newList()
    case 'list-delete':
      state.confirmList = true
      return render(['header'])
    case 'list-delete-no':
      state.confirmList = false
      return render(['header'])
    case 'list-delete-yes':
      return deleteCurrentList()
    case 'export-markdown':
      return saveFile(
        fileName(currentList(state.prefs).title, 'md'),
        'text/markdown',
        exportMarkdown(state.todos, currentList(state.prefs))
      )
    case 'export-json':
      return saveFile('simple-todo-backup.json', 'application/json', exportJson(state.todos, state.prefs.lists, Date.now()))
    case 'import':
      state.popover = null
      render(['header'])
      return (document.getElementById('import-file') as HTMLInputElement).click()
    case 'copy-inbox':
      return void copyInboxInstructions()
    case 'search-toggle':
      return setSearching(!state.searching)
    case 'form-submit':
      return submitForm(scope)
    case 'form-cancel':
      return closeForm(scope)
    case 'form-preview': {
      const form = formIn(scope)
      if (form) {
        changeForm(scope, { preview: !form.preview })
        render(scope === 'add' ? ['composer'] : ['list'])
      }
      return
    }

    case 'tab':
      setPrefs({ view: value as View })
      state.row = null
      state.confirmClear = false
      state.popover = null
      return render(['header', 'summary', 'list'])

    case 'view-toggle':
      state.popover = state.popover === 'view' ? null : 'view'
      return render(['header', 'summary'])

    case 'filter-toggle':
      state.popover = state.popover === 'filter' ? null : 'filter'
      return render(['header', 'summary'])
    case 'filter-project':
      setPrefs({ hiddenProjects: toggled(state.prefs.hiddenProjects, value) })
      return render(['header', 'summary', 'list'])
    case 'filter-priority':
      setPrefs({ hiddenPriorities: toggled(state.prefs.hiddenPriorities, value as Priority) })
      return render(['header', 'summary', 'list'])
    case 'filter-all':
      setPrefs(value === 'projects' ? { hiddenProjects: [] } : { hiddenPriorities: [] })
      return render(['header', 'summary', 'list'])
    case 'filter-none':
      setPrefs(
        value === 'projects'
          ? { hiddenProjects: filterProjects(listTodos(state)) }
          : { hiddenPriorities: [...PRIORITIES] }
      )
      return render(['header', 'summary', 'list'])

    case 'filter-tag':
      setPrefs({ tags: toggled(state.prefs.tags, value) })
      return render(['header', 'summary', 'list'])
    case 'filter-tags-clear':
      setPrefs({ tags: [] })
      return render(['header', 'summary', 'list'])
    case 'filter-due':
      setPrefs({ due: value as DueFilter })
      return render(['header', 'summary', 'list'])
    case 'tag':
      // A tag on a card narrows the list to that tag; pressing it again widens it back.
      setPrefs({ tags: state.prefs.tags.length === 1 && state.prefs.tags[0] === value ? [] : [value] })
      return render(['header', 'summary', 'list'])

    case 'sort-toggle':
      state.popover = state.popover === 'sort' ? null : 'sort'
      return render(['header', 'summary'])
    case 'sort':
      setPrefs({ sort: value as Sort })
      state.popover = null
      return render(['summary', 'list'])

    case 'clear-ask':
      state.confirmClear = true
      return render(['summary'])
    case 'clear-no':
      state.confirmClear = false
      return render(['summary'])
    case 'clear-yes': {
      state.confirmClear = false
      const before = state.todos
      // Only the done to-dos in view: a filter or search narrows what is cleared.
      const ids = shownTodos()
        .filter((item) => item.done)
        .map((item) => item.id)
      setTodos(removeTodos(before, ids))
      render()
      return showToast('neutral', `Deleted ${ids.length} done ${ids.length === 1 ? 'to-do' : 'to-dos'}.`, before)
    }
    case 'archive-done': {
      const before = state.todos
      const ids = shownTodos()
        .filter((item) => item.done)
        .map((item) => item.id)
      setTodos(setArchived(before, ids, Date.now()))
      render()
      return showToast('neutral', `Archived ${ids.length} done ${ids.length === 1 ? 'to-do' : 'to-dos'}.`, before)
    }
    case 'archive':
      if (todo) {
        const before = state.todos
        setTodos(setArchived(before, [todo.id], Date.now()))
        state.row = null
        render()
        showToast('neutral', 'Archived.', before)
      }
      return
    case 'restore':
      if (todo) {
        setTodos(setArchived(state.todos, [todo.id], null))
        state.row = null
        render()
      }
      return
    case 'move-list':
      if (todo) {
        state.row = { kind: 'move', id: todo.id }
        render(['list'])
      }
      return
    case 'move-to':
      if (todo) {
        const name = state.prefs.lists.find((candidate) => candidate.id === value)?.title ?? 'the list'
        const before = state.todos
        setTodos(setList(before, todo.id, value))
        state.row = null
        render()
        showToast('neutral', `Moved to ${name}.`, before)
      }
      return
    case 'fold':
      if (todo) {
        state.expanded = toggled(state.expanded, todo.id)
        render(['list'])
      }
      return
    case 'undo':
      if (state.toast?.undo) {
        setTodos(state.toast.undo)
        clearTimeout(toastTimer)
        state.toast = null
        render()
      }
      return

    case 'done':
      if (todo) {
        setTodos(setDone(state.todos, todo.id, !todo.done, Date.now()))
        state.row = null
        render()
      }
      return
    case 'move-up':
    case 'move-down':
      if (todo) {
        reorder(nudgeTodo(state.todos, shownTodos(), todo.id, act === 'move-up' ? 'up' : 'down'))
      }
      return
    case 'menu':
      if (todo) {
        state.row = state.row?.kind === 'menu' && state.row.id === todo.id ? null : { kind: 'menu', id: todo.id }
        state.popover = null
        render(['header', 'summary', 'list'])
      }
      return
    case 'edit':
      if (todo) {
        state.row = { kind: 'edit', id: todo.id, form: formOf(todo) }
        render(['list'])
        focusField('text', 'edit')
      }
      return
    case 'delete':
      if (todo) {
        state.row = { kind: 'delete', id: todo.id }
        render(['list'])
      }
      return
    case 'delete-yes':
      if (todo) {
        const before = state.todos
        setTodos(removeTodos(before, [todo.id]))
        state.row = null
        render()
        showToast('neutral', 'Deleted.', before)
      }
      return
    case 'jump':
      if (todo) {
        jump(todo)
      }
      return
    case 'send':
      if (todo) {
        void openSend(todo)
      }
      return
    case 'row-close':
      state.row = null
      return render(['list'])

    case 'open-workspace':
      return void openWorkspace(value)
    case 'send-target':
      if (state.row?.kind === 'send') {
        state.row = { ...state.row, send: { ...state.row.send, target: value } }
        render(['list'])
      }
      return
    case 'send-submit':
      if (todo) {
        void submitSend(todo)
      }
      return

    case 'box': {
      // A task box inside a to-do: tick it in the text itself.
      const index = Number(target.dataset.box)
      if (todo && Number.isInteger(index)) {
        setTodos(patchTodo(state.todos, todo.id, { text: toggleTaskBox(todo.text, index) }))
        render(['list'])
      }
      return
    }
    case 'link': {
      const href = target.dataset.href
      // Older Orca has no way for a panel to open a link.
      if (href && orca.shell) {
        orca.shell.openExternal(href).catch((error: unknown) => {
          showToast('danger', `Could not open the link: ${report(error)}`)
        })
      }
      return
    }
    case 'toast-close':
      clearTimeout(toastTimer)
      state.toast = null
      return render(['toast'])
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const control = target.closest<HTMLElement>('[data-act]')
  // A click anywhere else closes what floats: the filter, the sort list, a row's menu.
  if (!target.closest('.popover') && !control?.matches('[data-act$="-toggle"], [data-act="menu"]')) {
    const hadMenu = state.row?.kind === 'menu'
    if (state.popover !== null || hadMenu) {
      state.popover = null
      if (hadMenu) {
        state.row = null
      }
      if (!control) {
        render(['header', 'summary', 'list'])
        return
      }
    }
  }
  if (control && !(control as HTMLButtonElement).disabled) {
    // A link or task box inside a label must not also act as the label.
    if (control.dataset.act === 'link') {
      event.preventDefault()
    }
    onAct(control.dataset.act ?? '', control)
  }
})

// Double-clicking a to-do opens it for editing. Its controls keep their own meaning: a quick
// second click on a tick box, a button, a link or the drag handle is not a request to edit.
document.addEventListener('dblclick', (event) => {
  const target = event.target as HTMLElement
  const row = target.closest<HTMLElement>('.row[data-id]')
  if (!row || row.classList.contains('editing')) {
    return
  }
  if (target.closest('button, a, input, select, textarea, label, .grip, .popover, .section')) {
    return
  }
  const todo = todoOf(row.dataset.id)
  if (todo) {
    // The double click selected a word; that selection belongs to text about to be replaced.
    window.getSelection()?.removeAllRanges()
    state.popover = null
    state.row = { kind: 'edit', id: todo.id, form: formOf(todo) }
    render(['header', 'summary', 'list'])
    focusField('text', 'edit')
  }
})

// --- typing and choosing -------------------------------------------------------------------

function onInput(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  const scope = field.dataset.scope ?? ''
  switch (field.dataset.input) {
    case 'search':
      state.search = field.value
      state.confirmClear = false
      return render(['summary', 'list'])
    case 'text': {
      const form = formIn(scope)
      if (!form || !(field instanceof HTMLTextAreaElement)) {
        return
      }
      // Typing `[` after a list marker completes the task box.
      const assisted = completeTaskBox(form.text, field.value)
      if (assisted !== field.value) {
        const caret = (field.selectionStart ?? field.value.length) + (assisted.length - field.value.length)
        field.value = assisted
        field.setSelectionRange(caret, caret)
      }
      // Only the submit button depends on the text: no redraw while typing.
      syncText(field)
      updateMenu(field)
      return
    }
    case 'title':
      return fitTitle(field as HTMLInputElement)
    case 'customProject':
      return changeForm(scope, { customProject: field.value })
    case 'tags':
      return changeForm(scope, { tags: field.value })
    case 'due':
      changeForm(scope, { due: field.value })
      // Only how the empty date box is drawn depends on it.
      field.classList.toggle('unset', !field.value)
      return
    case 'project':
      if (field.value === 'other') {
        changeForm(scope, { custom: true })
        render(scope === 'add' ? ['composer'] : ['list'])
        return focusField('customProject', scope)
      }
      changeForm(scope, {
        custom: false,
        project: field.value.startsWith(PROJECT_PREFIX) ? field.value.slice(PROJECT_PREFIX.length) : NO_PROJECT
      })
      return render(scope === 'add' ? ['composer'] : ['list'])
    case 'priority':
      changeForm(scope, { priority: field.value as Priority })
      return render(scope === 'add' ? ['composer'] : ['list'])
    case 'send-agent':
      return setPrefs({ agentKind: field.value })
    case 'send-workspace':
      if (state.row?.kind === 'send') {
        state.row = { ...state.row, send: { ...state.row.send, workspace: field.value } }
        render(['list'])
      }
      return
  }
}

document.addEventListener('input', (event) => {
  const field = event.target as HTMLElement
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    onInput(field)
  }
})

document.addEventListener('change', (event) => {
  const field = event.target as HTMLElement
  if (field instanceof HTMLSelectElement) {
    onInput(field)
  }
})

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement
  // A focused drag handle moves its to-do with the arrow keys.
  const grip = target.closest<HTMLElement>('[data-drag]')
  if (grip?.dataset.drag && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    return nudgeFromGrip(grip.dataset.drag, event.key === 'ArrowUp' ? 'up' : 'down')
  }
  // While the "/" menu is open, the keys that move through a list belong to it.
  if (caretMenu && target === caretMenu.field) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const size = caretMenu.count
      if (size > 0) {
        caretMenu.active = (caretMenu.active + (event.key === 'ArrowDown' ? 1 : size - 1)) % size
        drawMenu()
      }
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing && caretMenu.count > 0) {
      event.preventDefault()
      return caretMenu.pick(caretMenu.active)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      return closeMenu()
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      closeMenu()
    }
  }
  if (target.dataset?.input === 'title' && (event.key === 'Enter' || event.key === 'Escape')) {
    event.preventDefault()
    return endRename(event.key === 'Enter')
  }
  if (event.key === 'Escape' && target.id === 'search') {
    return setSearching(false)
  }
  if (event.key === 'Escape') {
    if (state.popover !== null || state.row?.kind === 'menu') {
      state.popover = null
      if (state.row?.kind === 'menu') {
        state.row = null
      }
      render(['header', 'summary', 'list'])
    } else if (state.row !== null) {
      state.row = null
      render(['list'])
    } else if (state.adding) {
      closeForm('add')
    }
    return
  }
  if (!(target instanceof HTMLTextAreaElement) || target.dataset.input !== 'text') {
    if (
      event.key === 'Enter' &&
      target instanceof HTMLInputElement &&
      (target.dataset.input === 'customProject' || target.dataset.input === 'tags')
    ) {
      submitForm(target.dataset.scope ?? '')
    }
    return
  }
  const scope = target.dataset.scope ?? ''
  if (event.key !== 'Enter' || event.isComposing) {
    return
  }
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault()
    return submitForm(scope)
  }
  if (event.shiftKey || event.altKey || target.selectionStart !== target.selectionEnd) {
    return
  }
  // Enter in a list continues it, or ends it on an empty item.
  const caret = target.selectionStart
  const before = target.value
  const plain = `${before.slice(0, caret)}\n${before.slice(caret)}`
  const assisted = continueList(before, plain)
  if (assisted !== plain) {
    event.preventDefault()
    const next = caret + (assisted.length - before.length)
    target.value = assisted
    target.setSelectionRange(next, next)
    syncText(target)
  }
})

// --- start ---------------------------------------------------------------------------------

async function start(): Promise<void> {
  render()
  const [todos, prefs, draft] = await Promise.all([
    orca.storage.get(TODOS_KEY),
    orca.storage.get(PREFS_KEY),
    orca.storage.get(DRAFT_KEY)
  ])
  state.todos = parseTodos(todos)
  state.prefs = parsePrefs(prefs)
  state.draft = parseDraft(draft)
  render()

  // Another open panel of this plugin, or the worker, changed the list.
  orca.storage.onDidChange(({ key }) => {
    if (key !== TODOS_KEY) {
      return
    }
    void orca.storage.get(TODOS_KEY).then((stored) => {
      const next = parseTodos(stored)
      if (JSON.stringify(next) !== JSON.stringify(state.todos)) {
        state.todos = next
        render()
      }
    })
  })

  // The quick-add shortcut: the worker says so to an open panel, and keeps it for one that is opening.
  orca.plugin.on('compose', () => openComposer())
  void orca.plugin
    .request('compose.take')
    .then(({ pending }) => {
      if (pending) {
        openComposer()
      }
    })
    .catch(() => undefined)

  void loadProjects()
  orca.on('workspace.created', () => void loadProjects())
  orca.on('workspace.removed', () => void loadProjects())
  // Ages ("5m ago") move on while the panel stays open; nothing is redrawn mid-edit.
  setInterval(() => {
    if (state.row === null && state.popover === null) {
      render(['list'])
    }
  }, AGE_REFRESH_MS)
}

void start().catch((error: unknown) => showToast('danger', `Could not load: ${report(error)}`))
