import { assert, test } from 'orca/testing'
import type { Todo } from '../core/types.ts'
import type { AgentOption, OrcaProject } from '../protocol.ts'
import {
  addList,
  addTodo,
  agentPlace,
  canSend,
  cleanTitle,
  countsOf,
  currentList,
  DEFAULT_PREFS,
  EMPTY_FORM,
  fieldsOf,
  filterProjects,
  formOf,
  initialState,
  isFiltered,
  moveTodo,
  nudgeTodo,
  NEW_AGENT,
  NO_PROJECT,
  parseDraft,
  parsePrefs,
  patchTodo,
  projectChoices,
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
  workspaceOptions,
  type UiState
} from './state.ts'

const seed: Todo[] = [
  { id: 'a', text: 'Write docs', done: false, createdAt: 1, project: 'orca' },
  { id: 'b', text: 'Ship it', done: true, createdAt: 2, project: 'orca' },
  { id: 'c', text: 'Fix the **login** bug', done: false, createdAt: 3, project: 'web', priority: 'urgent' },
  { id: 'd', text: 'Buy milk', done: false, createdAt: 4 }
]

const server = { id: 'env-1', name: 'build-box' }
const projects: OrcaProject[] = [
  { name: 'api', workspaces: [{ id: 'api-main', kind: 'worktree', name: 'api', branch: 'main' }] },
  { name: 'infra', workspaces: [{ id: 'infra-main', kind: 'worktree', name: 'main', branch: 'main', environment: server }] },
  {
    name: 'web',
    workspaces: [
      { id: 'web-main', kind: 'worktree', name: 'web', branch: 'main' },
      { id: 'web-fix', kind: 'worktree', name: 'fix-login', branch: 'fix-login' }
    ]
  }
]
const agents: AgentOption[] = [
  { terminalId: 't1', title: 'Tune queries', agent: 'claude', workspaceId: 'api-main' },
  { terminalId: 't2', title: 'Fix login', agent: 'codex', workspaceId: 'web-fix' },
  { terminalId: 't1', title: 'Rotate keys', agent: 'claude', workspaceId: 'infra-main', environment: server }
]

function stateOf(patch: Partial<UiState> = {}): UiState {
  return { ...initialState(), todos: seed, ...patch }
}
const ids = (todos: readonly Todo[]) => todos.map((todo) => todo.id)
const TODAY = '2026-03-04'

test('parsePrefs and parseDraft fall back on anything malformed', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS)
  assert.deepEqual(
    parsePrefs({ view: 'nope', sort: 'newest', hiddenProjects: ['web', 3], hiddenPriorities: ['low', 'bogus'], agentKind: '', tags: ['bug', 1], due: 'week' }),
    { ...DEFAULT_PREFS, sort: 'newest', hiddenProjects: ['web'], hiddenPriorities: ['low'], tags: ['bug'], due: 'week' }
  )
  assert.equal(parsePrefs({ view: 'archived', sort: 'due', due: 'bogus' }).view, 'archived')
  assert.equal(parsePrefs({ sort: 'due' }).sort, 'due')
  assert.equal(parsePrefs({ due: 'bogus' }).due, 'any')
  assert.equal(cleanTitle('x'.repeat(60)).length, 40)
  assert.deepEqual(parseDraft('x'), EMPTY_FORM)
  assert.deepEqual(parseDraft({ text: 'Half', priority: 'low', preview: true, custom: true, customProject: 'x', tags: 'a b', due: '2026-03-05' }), {
    ...EMPTY_FORM,
    text: 'Half',
    priority: 'low',
    custom: true,
    customProject: 'x',
    tags: 'a b',
    due: '2026-03-05'
  })
  assert.equal(parseDraft({ due: 'tomorrow' }).due, '')
})

test('lists: the old single title becomes the first list, and lists can be added, renamed and removed', () => {
  // Stored before there were several lists.
  assert.deepEqual(parsePrefs({ title: '  My   list ' }).lists, [{ id: 'default', title: 'My list' }])
  assert.deepEqual(parsePrefs({ title: 7 }).lists, [{ id: 'default', title: 'Simple Todo' }])
  const stored = parsePrefs({ lists: [{ id: 'work', title: 'Work' }, { id: 'work', title: 'Twice' }, { title: 'no id' }], list: 'work' })
  assert.deepEqual(stored.lists, [{ id: 'default', title: 'Simple Todo' }, { id: 'work', title: 'Work' }])
  assert.equal(stored.list, 'work')
  assert.equal(parsePrefs({ list: 'gone' }).list, 'default')

  const added = addList(DEFAULT_PREFS, 'home', '  ')
  assert.deepEqual(added.lists[1], { id: 'home', title: 'New list' })
  assert.equal(added.list, 'home')
  assert.equal(currentList(renameList(added, 'home', 'Home')).title, 'Home')
  // An empty name keeps the old one.
  assert.equal(currentList(renameList(added, 'home', '  ')).title, 'New list')
  const removed = removeList(added, 'home')
  assert.deepEqual(removed.lists, DEFAULT_PREFS.lists)
  assert.equal(removed.list, 'default')
  // The first list stays.
  assert.equal(removeList(added, 'default'), added)
})

test('a form stands for trimmed fields, with empty ones left out', () => {
  assert.deepEqual(fieldsOf({ ...EMPTY_FORM, text: '  Do it  ' }), { text: 'Do it' })
  assert.deepEqual(fieldsOf({ ...EMPTY_FORM, text: 'x', project: 'web', priority: 'high' }), {
    text: 'x',
    project: 'web',
    priority: 'high'
  })
  // A name typed by hand wins over the picked one.
  assert.deepEqual(fieldsOf({ ...EMPTY_FORM, text: 'x', project: 'web', custom: true, customProject: ' errands ' }), {
    text: 'x',
    project: 'errands'
  })
})

test('adds, edits, patches and removes tasks', () => {
  assert.deepEqual(addTodo([], { ...EMPTY_FORM, text: ' ' }, 'n', 9), [])
  assert.deepEqual(addTodo([], { ...EMPTY_FORM, text: 'New', priority: 'low' }, 'n', 9), [
    { id: 'n', done: false, createdAt: 9, text: 'New', priority: 'low' }
  ])
  // Editing replaces the fields: the urgent flag and the tag go when the form drops them.
  const edited = updateTodo(seed, 'c', { ...formOf(seed[2]), text: 'Fixed', project: NO_PROJECT, priority: 'none' })
  assert.deepEqual(edited[2], { id: 'c', done: false, createdAt: 3, text: 'Fixed' })
  assert.deepEqual(updateTodo(seed, 'c', { ...EMPTY_FORM, text: '' }), seed)
  assert.equal(patchTodo(seed, 'a', { done: true })[0].done, true)
  assert.deepEqual(ids(removeTodos(seed, ['a', 'd'])), ['b', 'c'])
})

test('counts open, done, urgent, overdue and archived to-dos', () => {
  assert.deepEqual(countsOf(seed, TODAY), { open: 3, done: 1, urgent: 1, overdue: 0, archived: 0 })
  const more: Todo[] = [...seed, { id: 'o', text: 'Late', done: false, createdAt: 9, due: '2026-03-01' }, { id: 'z', text: 'Put away', done: true, createdAt: 9, archivedAt: 10 }]
  assert.deepEqual(countsOf(more, TODAY), { open: 4, done: 1, urgent: 1, overdue: 1, archived: 1 })
})

test('lists the tab, most pressing first, done tasks last', () => {
  assert.deepEqual(ids(visibleTodos(stateOf(), TODAY)), ['c', 'a', 'd'])
  assert.deepEqual(ids(visibleTodos(stateOf({ prefs: { ...DEFAULT_PREFS, view: 'done' } }), TODAY)), ['b'])
  assert.deepEqual(ids(visibleTodos(stateOf({ prefs: { ...DEFAULT_PREFS, view: 'all' } }), TODAY)), ['c', 'a', 'd', 'b'])
  assert.deepEqual(ids(visibleTodos(stateOf({ prefs: { ...DEFAULT_PREFS, sort: 'newest' } }), TODAY)), ['d', 'c', 'a'])
  assert.deepEqual(ids(visibleTodos(stateOf({ prefs: { ...DEFAULT_PREFS, sort: 'oldest' } }), TODAY)), ['a', 'c', 'd'])
})

test('filters by project, priority and search together', () => {
  const hidden = (hiddenProjects: string[], hiddenPriorities: UiState['prefs']['hiddenPriorities'] = []) =>
    stateOf({ prefs: { ...DEFAULT_PREFS, hiddenProjects, hiddenPriorities } })
  assert.deepEqual(ids(visibleTodos(hidden(['web']), TODAY)), ['a', 'd'])
  assert.deepEqual(ids(visibleTodos(hidden([NO_PROJECT, 'orca']), TODAY)), ['c'])
  assert.deepEqual(ids(visibleTodos(hidden([], ['none']), TODAY)), ['c'])
  assert.deepEqual(ids(visibleTodos(stateOf({ search: 'LOGIN' }), TODAY)), ['c'])
  assert.deepEqual(ids(visibleTodos(stateOf({ search: 'orca' }), TODAY)), ['a'])

  assert.deepEqual(filterProjects(seed), ['orca', 'web', NO_PROJECT])
  assert.equal(isFiltered(stateOf()), false)
  assert.equal(isFiltered(hidden(['web'])), true)
  // A hidden project whose tasks are gone hides nothing.
  assert.equal(isFiltered(hidden(['gone'])), false)
  assert.deepEqual(toggled(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggled(['a', 'b'], 'a'), ['b'])
})

test('offers Orca projects and hand-typed tags together', () => {
  assert.deepEqual(projectChoices({ todos: seed, projects }), ['api', 'infra', 'orca', 'web'])
})

test('names workspaces and where agents run', () => {
  assert.deepEqual(workspaceOptions(projects), [
    { value: '|api-main', label: 'api (main)' },
    { value: 'env-1|infra-main', label: 'infra / main on build-box' },
    { value: '|web-main', label: 'web (main)' },
    { value: '|web-fix', label: 'web / fix-login' }
  ])
  assert.equal(agentPlace(projects, agents[1]), 'codex · web / fix-login')
  assert.equal(agentPlace(projects, agents[2]), 'claude · infra / main · build-box')
  assert.equal(agentPlace([], agents[0]), 'claude')
})

test('sending starts in the task\'s project and prefers agents already there', () => {
  const start = startSend(projects, seed[2])
  assert.deepEqual(start, { agents: null, target: NEW_AGENT, workspace: '|web-main', busy: false })
  assert.equal(canSend(projects, start), false)

  const none = withAgents(projects, start, [], seed[2])
  assert.equal(none.target, NEW_AGENT)
  assert.equal(canSend(projects, none), true)
  assert.equal(canSend([], none), false)

  const some = withAgents(projects, start, agents, seed[2])
  assert.deepEqual(some.agents?.map((agent) => agent.title), ['Fix login', 'Tune queries', 'Rotate keys'])
  assert.equal(some.target, '|t2')
  assert.equal(canSend(projects, some), true)
  assert.equal(canSend(projects, { ...some, busy: true }), false)
  assert.equal(canSend(projects, { ...some, target: '|gone' }), false)
  // No Orca project for the task: the first workspace Orca lists.
  assert.equal(startSend(projects, seed[3]).workspace, '|api-main')
  assert.equal(startSend([], seed[3]).workspace, '')
})

test('moves a task among the listed ones and leaves hidden ones where they are', () => {
  const list: Todo[] = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, text: id, done: id === 'b', createdAt: index }))
  const open = list.filter((todo) => !todo.done) // a c d e; b is hidden (done)
  assert.deepEqual(ids(moveTodo(list, open, 'e', 'a', 'before')), ['e', 'b', 'a', 'c', 'd'])
  assert.deepEqual(ids(moveTodo(list, open, 'a', 'd', 'after')), ['c', 'b', 'd', 'a', 'e'])
  assert.deepEqual(ids(moveTodo(list, open, 'a', 'c', 'before')), ['a', 'b', 'c', 'd', 'e'])
  // Listed in another order (say, by priority): that order is what gets rearranged and kept.
  const byPriority = [open[3], open[0], open[2], open[1]] // e a d c
  assert.deepEqual(ids(moveTodo(list, byPriority, 'c', 'e', 'before')), ['c', 'b', 'e', 'a', 'd'])
})

test('refuses a move that makes no sense', () => {
  const list: Todo[] = [
    { id: 'a', text: 'a', done: false, createdAt: 1 },
    { id: 'b', text: 'b', done: true, createdAt: 2 }
  ]
  assert.deepEqual(moveTodo(list, list, 'a', 'a', 'before'), list)
  assert.deepEqual(moveTodo(list, list, 'a', 'gone', 'before'), list)
  // An open task does not land among the done ones.
  assert.deepEqual(moveTodo(list, list, 'a', 'b', 'after'), list)
})

test('nudges a task up or down among its own kind', () => {
  const list: Todo[] = ['a', 'b', 'c'].map((id, index) => ({ id, text: id, done: false, createdAt: index }))
  assert.deepEqual(ids(nudgeTodo(list, list, 'c', 'up')), ['a', 'c', 'b'])
  assert.deepEqual(ids(nudgeTodo(list, list, 'a', 'down')), ['b', 'a', 'c'])
  assert.deepEqual(ids(nudgeTodo(list, list, 'a', 'up')), ['a', 'b', 'c'])
  assert.deepEqual(ids(nudgeTodo(list, list, 'c', 'down')), ['a', 'b', 'c'])
})

test('manual order lists tasks as stored', () => {
  const manual = stateOf({ prefs: { ...DEFAULT_PREFS, sort: 'manual' } })
  assert.deepEqual(ids(visibleTodos(manual, TODAY)), ['a', 'c', 'd'])
  assert.equal(parsePrefs({ sort: 'manual' }).sort, 'manual')
})

test('a form carries tags and a due day', () => {
  assert.deepEqual(fieldsOf({ ...EMPTY_FORM, text: 'x', tags: '#bug, idea  bug', due: '2026-03-09' }), {
    text: 'x',
    tags: ['bug', 'idea'],
    due: '2026-03-09'
  })
  assert.deepEqual(fieldsOf({ ...EMPTY_FORM, text: 'x', tags: ' , ', due: 'soon' }), { text: 'x' })
  const todo: Todo = { id: 'a', text: 'A', done: false, createdAt: 1, tags: ['bug', 'ui'], due: '2026-03-09' }
  assert.equal(formOf(todo).tags, 'bug, ui')
  assert.equal(formOf(todo).due, '2026-03-09')
})

test('editing keeps what the form does not edit', () => {
  const todo: Todo = { id: 'a', text: 'A', done: true, createdAt: 1, doneAt: 5, list: 'work', tags: ['x'], agent: { terminalId: 't', title: 'T', sentAt: 2 } }
  assert.deepEqual(updateTodo([todo], 'a', { ...formOf(todo), text: 'B', tags: '' }), [
    { id: 'a', done: true, createdAt: 1, doneAt: 5, list: 'work', agent: { terminalId: 't', title: 'T', sentAt: 2 }, text: 'B' }
  ])
})

test('a new to-do goes to the list being shown', () => {
  assert.equal(addTodo([], { ...EMPTY_FORM, text: 'x' }, 'n', 1, 'work')[0].list, 'work')
  assert.equal('list' in addTodo([], { ...EMPTY_FORM, text: 'x' }, 'n', 1, 'default')[0], false)
})

test('marks done with a time, archives, restores and moves between lists', () => {
  const done = setDone(seed, 'a', true, 50)
  assert.equal(done[0].doneAt, 50)
  assert.equal('doneAt' in setDone(done, 'a', false, 60)[0], false)
  const archived = setArchived(seed, ['b'], 70)
  assert.equal(archived[1].archivedAt, 70)
  assert.equal('archivedAt' in setArchived(archived, ['b'], null)[1], false)
  assert.equal(setList(seed, 'a', 'work')[0].list, 'work')
  assert.equal('list' in setList(setList(seed, 'a', 'work'), 'a', 'default')[0], false)
})

test('each list shows its own to-dos, and archived ones only under Archived', () => {
  const todos: Todo[] = [
    ...seed,
    { id: 'w', text: 'Work thing', done: false, createdAt: 9, list: 'work' },
    { id: 'z', text: 'Put away', done: true, createdAt: 9, archivedAt: 10 }
  ]
  const prefs = { ...DEFAULT_PREFS, lists: [...DEFAULT_PREFS.lists, { id: 'work', title: 'Work' }] }
  assert.deepEqual(ids(visibleTodos(stateOf({ todos, prefs }), TODAY)), ['c', 'a', 'd'])
  assert.deepEqual(ids(visibleTodos(stateOf({ todos, prefs: { ...prefs, list: 'work' } }), TODAY)), ['w'])
  assert.deepEqual(ids(visibleTodos(stateOf({ todos, prefs: { ...prefs, view: 'all' } }), TODAY)), ['c', 'a', 'd', 'b'])
  assert.deepEqual(ids(visibleTodos(stateOf({ todos, prefs: { ...prefs, view: 'archived' } }), TODAY)), ['z'])
})

test('filters by tag and due day, sorts by due day, and searches tags', () => {
  const todos: Todo[] = [
    { id: 'late', text: 'Late', done: false, createdAt: 1, due: '2026-03-01', tags: ['Bug'] },
    { id: 'now', text: 'Now', done: false, createdAt: 2, due: TODAY, priority: 'urgent' },
    { id: 'soon', text: 'Soon', done: false, createdAt: 3, due: '2026-03-10', tags: ['idea'] },
    { id: 'far', text: 'Far', done: false, createdAt: 4, due: '2026-06-01' },
    { id: 'free', text: 'Free', done: false, createdAt: 5 }
  ]
  const shown = (prefs: Partial<UiState['prefs']>, search = '') =>
    ids(visibleTodos(stateOf({ todos, search, prefs: { ...DEFAULT_PREFS, sort: 'manual', ...prefs } }), TODAY))
  assert.deepEqual(shown({ tags: ['bug'] }), ['late'])
  assert.deepEqual(shown({ tags: ['bug', 'idea'] }), ['late', 'soon'])
  // A tag no to-do carries any more filters nothing.
  assert.deepEqual(shown({ tags: ['gone'] }).length, 5)
  assert.deepEqual(shown({ due: 'overdue' }), ['late'])
  assert.deepEqual(shown({ due: 'today' }), ['now'])
  assert.deepEqual(shown({ due: 'week' }), ['late', 'now', 'soon'])
  assert.deepEqual(shown({ due: 'none' }), ['free'])
  assert.deepEqual(shown({ sort: 'due' }), ['late', 'now', 'soon', 'far', 'free'])
  assert.deepEqual(shown({}, '#idea'), ['soon'])

  const state = (prefs: Partial<UiState['prefs']>) => stateOf({ todos, prefs: { ...DEFAULT_PREFS, ...prefs } })
  assert.equal(isFiltered(state({ tags: ['bug'] })), true)
  assert.equal(isFiltered(state({ tags: ['gone'] })), false)
  assert.equal(isFiltered(state({ due: 'today' })), true)
})
