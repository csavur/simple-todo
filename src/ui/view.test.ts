// The view is pure: each region is a string, checked here without a browser.
import { assert, test } from 'orca/testing'
import type { Todo } from '../core/types.ts'
import type { OrcaProject } from '../protocol.ts'
import { DEFAULT_PREFS, EMPTY_FORM, formOf, initialState, NEW_AGENT, startSend, withAgents, type UiState } from './state.ts'
import { matchSlash } from '../core/slash.ts'
import { dayOf } from '../core/todos.ts'
import { addDays } from '../core/transfer.ts'
import { ageOf, composer, filterPopover, header, isLong, list, listsPopover, slashMenu, summary, toast } from './view.ts'

const NOW = 10 * 24 * 60 * 60_000
const minutes = (n: number) => NOW - n * 60_000
const seed: Todo[] = [
  { id: 'a', text: 'Write docs', done: false, createdAt: minutes(5), project: 'orca' },
  { id: 'b', text: 'Ship it', done: true, createdAt: minutes(90), project: 'web' },
  { id: 'c', text: 'Fix **login**\n- [ ] repro', done: false, createdAt: minutes(3000), project: 'web', priority: 'urgent' },
  { id: 'd', text: '<img src=x onerror=alert(1)>', done: false, createdAt: minutes(0) }
]
const projects: OrcaProject[] = [
  {
    name: 'web',
    workspaces: [
      { id: 'web-main', kind: 'worktree', name: 'web', branch: 'main' },
      { id: 'web-fix', kind: 'worktree', name: 'fix-login', branch: 'fix-login' }
    ]
  }
]
const KINDS = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]

function stateOf(patch: Partial<UiState> = {}): UiState {
  return { ...initialState(), todos: seed, projects, ...patch }
}
const count = (html: string, needle: string) => html.split(needle).length - 1

test('ages are short', () => {
  assert.equal(ageOf(minutes(0), NOW), 'now')
  assert.equal(ageOf(minutes(5), NOW), '5m ago')
  assert.equal(ageOf(minutes(90), NOW), '1h ago')
  assert.equal(ageOf(minutes(3000), NOW), '2d ago')
})

test('the header counts open to-dos and lights the filter when it hides something', () => {
  const plain = header(stateOf(), NOW)
  assert.ok(plain.includes('3 open · 1 urgent'))
  assert.ok(plain.includes('data-act="lists-toggle" aria-expanded="false"'))
  assert.ok(plain.includes('<span class="truncate">Simple Todo</span>'))
  // Still called by the default name: the pencil shows all the time.
  assert.ok(plain.includes('<button class="title-edit unnamed" type="button" data-act="title-edit"'))
  assert.ok(plain.includes('aria-label="New to-do"'))
  assert.ok(plain.includes('data-act="search-toggle" title="Search" aria-label="Search" aria-expanded="false"'))
  assert.ok(header(stateOf({ searching: true }), NOW).includes('aria-label="Close search" aria-expanded="true"'))
  assert.ok(!plain.includes('data-on="true"'))
  assert.ok(!plain.includes('class="popover'))

  const filtered = header(stateOf({ prefs: { ...DEFAULT_PREFS, hiddenProjects: ['web'] }, popover: 'filter', adding: true }), NOW)
  assert.ok(filtered.includes('data-on="true"'))
  assert.ok(filtered.includes('class="popover filter-popover"'))
  assert.ok(filtered.includes('aria-label="Close"'))

  const late: Todo[] = [...seed, { id: 'o', text: 'Late', done: false, createdAt: NOW, due: addDays(dayOf(NOW), -3) }]
  assert.ok(header(stateOf({ todos: late }), NOW).includes('<span class="overdue">1 overdue</span>'))
})

test('the title is the name of the list shown, and becomes a text box while renaming', () => {
  const prefs = { ...DEFAULT_PREFS, lists: [{ id: 'default', title: 'Work <now>' }] }
  const named = stateOf({ prefs })
  assert.ok(header(named, NOW).includes('<span class="truncate">Work &lt;now&gt;</span>'))
  assert.ok(header(named, NOW).includes('<button class="title-edit" type="button"'))
  const renaming = header({ ...named, renaming: true }, NOW)
  assert.ok(renaming.includes('data-input="title" maxlength="40" aria-label="List name" value="Work &lt;now&gt;"'))
  assert.ok(!renaming.includes('data-act="lists-toggle"'))
})

test('the list menu switches lists and holds export, import and delete', () => {
  const prefs = { ...DEFAULT_PREFS, lists: [...DEFAULT_PREFS.lists, { id: 'work', title: 'Work' }], list: 'work' }
  const todos: Todo[] = [...seed, { id: 'w', text: 'Work thing', done: false, createdAt: NOW, list: 'work' }]
  const html = listsPopover(stateOf({ todos, prefs }))
  assert.ok(html.includes('aria-checked="true" data-act="list-pick" data-value="work"'))
  assert.ok(html.includes('<span class="grow truncate">Simple Todo</span><span class="count">3</span>'))
  assert.ok(html.includes('<span class="grow truncate">Work</span><span class="count">1</span>'))
  for (const act of ['list-new', 'title-edit', 'export-markdown', 'export-json', 'import', 'copy-inbox', 'list-delete']) {
    assert.ok(html.includes(`data-act="${act}"`), act)
  }
  assert.ok(listsPopover(stateOf({ todos, prefs, confirmList: true })).includes('data-act="list-delete-yes"'))
  // The first list cannot be deleted.
  assert.ok(!listsPopover(stateOf()).includes('list-delete'))
  assert.ok(header(stateOf({ popover: 'lists' }), NOW).includes('class="popover lists-popover"'))
})

test('the filter lists projects with tasks and every priority, ticked unless hidden', () => {
  const html = filterPopover(stateOf({ prefs: { ...DEFAULT_PREFS, hiddenProjects: ['web'], hiddenPriorities: ['low'] } }))
  assert.equal(count(html, 'data-act="filter-project"'), 3)
  assert.ok(html.includes('aria-checked="false" data-act="filter-project" data-value="web"'))
  assert.ok(html.includes('aria-checked="true" data-act="filter-project" data-value="orca"'))
  assert.ok(html.includes('aria-checked="true" data-act="filter-project" data-value=""'))
  assert.ok(html.includes('No project'))
  assert.equal(count(html, 'data-act="filter-priority"'), 5)
  assert.ok(html.includes('aria-checked="false" data-act="filter-priority" data-value="low"'))
  // With no tagged or untagged task there is no project group at all.
  assert.ok(!filterPopover(stateOf({ todos: [] })).includes('Projects'))
  // No to-do has a tag: no tag group. The due group is always there.
  assert.ok(!html.includes('data-act="filter-tag"'))
  assert.equal(count(html, 'data-act="filter-due"'), 5)
  assert.ok(html.includes('aria-checked="true" data-act="filter-due" data-value="any"'))
})

test('the filter offers tags, ticked only when chosen, and a due day', () => {
  const todos: Todo[] = [...seed, { id: 't', text: 'Tagged', done: false, createdAt: NOW, tags: ['bug', 'ui'] }]
  const html = filterPopover(stateOf({ todos, prefs: { ...DEFAULT_PREFS, tags: ['BUG'], due: 'week' } }))
  assert.ok(html.includes('aria-checked="true" data-act="filter-tag" data-value="bug"'))
  assert.ok(html.includes('aria-checked="false" data-act="filter-tag" data-value="ui"'))
  assert.ok(html.includes('#ui'))
  assert.ok(html.includes('aria-checked="true" data-act="filter-due" data-value="week"'))
})

test('the status dropdown names the current view, and lists all three with their counts', () => {
  const closed = summary(stateOf({ prefs: { ...DEFAULT_PREFS, view: 'done' } }), NOW)
  assert.ok(closed.includes('data-act="view-toggle" aria-expanded="false"'))
  assert.ok(closed.includes('>Done<span class="count">1</span>'))
  assert.ok(!closed.includes('view-popover'))

  const open = summary(stateOf({ popover: 'view' }), NOW)
  assert.ok(open.includes('class="popover view-popover"'))
  assert.ok(open.includes('aria-checked="true" data-act="tab" data-value="open"'))
  assert.ok(open.includes('<span class="grow">Done</span><span class="count">1</span>'))
  assert.ok(open.includes('<span class="grow">All</span><span class="count">4</span>'))
  assert.ok(open.includes('<span class="grow">Archived</span><span class="count">0</span>'))
})

test('the summary counts what shows and offers to clear done tasks in view', () => {
  const open = summary(stateOf(), NOW)
  assert.ok(open.includes('>Open<span class="count">3</span>'))
  assert.ok(!open.includes('Clear done'))

  const all = stateOf({ prefs: { ...DEFAULT_PREFS, view: 'all' } })
  assert.ok(summary(all, NOW).includes('data-act="clear-ask"'))
  assert.ok(summary(all, NOW).includes('data-act="archive-done"'))
  // Archived to-dos are already put away: nothing to clear from there.
  const put: Todo[] = [{ id: 'z', text: 'Old', done: true, createdAt: NOW, archivedAt: NOW }]
  assert.ok(!summary(stateOf({ todos: put, prefs: { ...DEFAULT_PREFS, view: 'archived' } }), NOW).includes('clear-ask'))
  const asking = summary({ ...all, confirmClear: true }, NOW)
  assert.ok(asking.includes('Delete 1 done?') && asking.includes('data-act="clear-yes"'))
  // The count is what is listed, so a search narrows it.
  assert.ok(summary(stateOf({ search: 'docs' }), NOW).includes('>Open<span class="count">1</span>'))

  const sorting = summary(stateOf({ popover: 'sort', prefs: { ...DEFAULT_PREFS, sort: 'newest' } }), NOW)
  assert.ok(sorting.includes('aria-checked="true" data-act="sort" data-value="newest"'))
  assert.ok(sorting.includes('data-act="sort" data-value="manual"'))
  assert.ok(sorting.includes('data-act="sort" data-value="due"'))
})

test('the composer shows only when adding, with the draft in it', () => {
  assert.equal(composer(stateOf()), '')
  const html = composer(stateOf({ adding: true, draft: { ...EMPTY_FORM, text: 'a <b>', project: 'web', priority: 'high' } }))
  assert.ok(html.includes('>a &lt;b&gt;</textarea>'))
  assert.ok(html.includes('placeholder="Title, e.g. Fix the login redirect&#10;Details or a checklist. Type / for formatting."'))
  assert.ok(html.includes('<option value="p:web" selected>web</option>'))
  assert.ok(html.includes('<option value="high" selected>High</option>'))
  assert.ok(html.includes('data-act="form-submit" data-scope="add" >Add</button>'))
  assert.ok(html.includes('data-input="tags" data-scope="add"'))
  assert.ok(html.includes('class="field date unset" type="date" data-input="due" data-scope="add"'))
  const filled = composer(stateOf({ adding: true, draft: { ...EMPTY_FORM, text: 'x', tags: 'bug, "ui"', due: '2026-03-09' } }))
  assert.ok(filled.includes('value="bug, &quot;ui&quot;"'))
  assert.ok(filled.includes('class="field date" type="date" data-input="due" data-scope="add" aria-label="Due day" value="2026-03-09"'))
  assert.ok(composer(stateOf({ adding: true })).includes('data-scope="add" disabled>Add</button>'))
})

test('a form offers a hand-typed project, keeps a vanished one, and previews', () => {
  const custom = composer(stateOf({ adding: true, draft: { ...EMPTY_FORM, text: 'x', custom: true, customProject: 'err"ands' } }))
  assert.ok(custom.includes('<option value="other" selected>'))
  assert.ok(custom.includes('data-input="customProject" data-scope="add"'))
  assert.ok(custom.includes('value="err&quot;ands"'))

  const vanished = composer(stateOf({ adding: true, draft: { ...EMPTY_FORM, text: 'x', project: 'gone' } }))
  assert.ok(vanished.includes('<option value="p:gone" selected>gone</option>'))

  const preview = composer(stateOf({ adding: true, draft: { ...EMPTY_FORM, text: '**b**', preview: true } }))
  assert.ok(preview.includes('<strong>b</strong>') && !preview.includes('<textarea'))
})

test('rows show the task as Markdown, escaped, with its priority, project and age', () => {
  const html = list(stateOf(), NOW, KINDS)
  assert.equal(count(html, '<li class="row'), 3)
  // Most pressing first.
  assert.ok(html.indexOf('data-id="c"') < html.indexOf('data-id="a"'))
  assert.ok(html.includes('<strong>login</strong>'))
  assert.ok(html.includes('data-act="box" data-box="0" data-id="c"'))
  // The row carries its priority, which colours its left edge.
  assert.ok(html.includes('<li class="row priority-urgent" data-id="c">') && html.includes('Urgent'))
  assert.ok(html.includes('2d ago') && html.includes('5m ago'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('aria-label="Mark done &quot;Write docs&quot;"'))
  // Each row has a handle to drag it by.
  assert.equal(count(html, 'draggable="true"'), 3)
  assert.ok(html.includes('data-drag="a"'))
  assert.ok(html.includes('aria-label="Re-order &quot;Write docs&quot;: drag, or press the up and down arrow keys"'))
})

test('a done row can be reopened', () => {
  const html = list(stateOf({ prefs: { ...DEFAULT_PREFS, view: 'done' } }), NOW, KINDS)
  assert.ok(html.includes('<li class="row priority-none done"'))
  assert.ok(html.includes('aria-label="Reopen &quot;Ship it&quot;"'))
})

test('a row\'s menu offers its actions, and opening the project only for an Orca project', () => {
  const web = list(stateOf({ row: { kind: 'menu', id: 'c' } }), NOW, KINDS)
  for (const act of ['send', 'edit', 'jump', 'move-up', 'move-down', 'archive', 'delete']) {
    assert.ok(web.includes(`data-act="${act}" data-id="c"`), act)
  }
  // "orca" is a name typed by hand: there is nothing to open.
  const typed = list(stateOf({ row: { kind: 'menu', id: 'a' } }), NOW, KINDS)
  assert.ok(typed.includes('data-act="edit" data-id="a"') && !typed.includes('data-act="jump"'))
  // Moving to another list is only offered when there is one.
  assert.ok(!typed.includes('data-act="move-list"'))
  const prefs = { ...DEFAULT_PREFS, lists: [...DEFAULT_PREFS.lists, { id: 'work', title: 'Work' }] }
  assert.ok(list(stateOf({ prefs, row: { kind: 'menu', id: 'a' } }), NOW, KINDS).includes('data-act="move-list" data-id="a"'))
  const moving = list(stateOf({ prefs, row: { kind: 'move', id: 'a' } }), NOW, KINDS)
  assert.ok(moving.includes('data-act="move-to" data-id="a" data-value="work"'))
  assert.ok(!moving.includes('data-value="default"'))
})

test('a row can be edited in place, asked about before deleting, and offer its workspaces', () => {
  const editing = list(stateOf({ row: { kind: 'edit', id: 'c', form: formOf(seed[2]) } }), NOW, KINDS)
  assert.ok(editing.includes('<li class="row editing priority-urgent" data-id="c">'))
  assert.ok(editing.includes('data-input="text" data-scope="edit"'))
  assert.ok(editing.includes('<option value="urgent" selected>Urgent</option>'))
  assert.ok(editing.includes('>Save</button>'))

  const deleting = list(stateOf({ row: { kind: 'delete', id: 'a' } }), NOW, KINDS)
  assert.ok(deleting.includes('Delete this to-do?') && deleting.includes('data-act="delete-yes" data-id="a"'))

  const jumping = list(stateOf({ row: { kind: 'jump', id: 'c' } }), NOW, KINDS)
  assert.ok(jumping.includes('data-act="open-workspace" data-value="|web-fix"'))
  assert.ok(jumping.includes('web (main)'))
})

test('sending lists running agents and, for a new one, the agent and workspace', () => {
  const start = startSend(projects, seed[2])
  const loading = list(stateOf({ row: { kind: 'send', id: 'c', send: start } }), NOW, KINDS)
  assert.ok(loading.includes('Looking for agents'))

  const agents = [{ terminalId: 't1', title: 'Fix login', agent: 'codex', workspaceId: 'web-fix' }]
  const send = withAgents(projects, start, agents, seed[2])
  const running = list(stateOf({ row: { kind: 'send', id: 'c', send } }), NOW, KINDS)
  assert.ok(running.includes('aria-checked="true" data-act="send-target" data-value="|t1"'))
  assert.ok(running.includes('codex · web / fix-login'))
  assert.ok(!running.includes('data-input="send-workspace"'))
  assert.ok(running.includes('data-act="send-submit" data-id="c" >Send</button>'))

  const fresh = list(stateOf({ row: { kind: 'send', id: 'c', send: { ...send, target: NEW_AGENT } } }), NOW, KINDS)
  assert.ok(fresh.includes('<option value="|web-main" selected>'))
  assert.ok(fresh.includes('<option value="claude" selected>Claude Code</option>'))

  const nowhere = list(stateOf({ projects: [], row: { kind: 'send', id: 'c', send: { ...send, agents: [], target: NEW_AGENT } } }), NOW, KINDS)
  assert.ok(nowhere.includes('no workspace') && nowhere.includes('data-id="c" disabled>Send'))
  const busy = list(stateOf({ row: { kind: 'send', id: 'c', send: { ...send, busy: true } } }), NOW, KINDS)
  assert.ok(busy.includes('disabled>Sending…'))
})

test('a card shows tags, the due day, progress on its task boxes, and where it was sent', () => {
  const todos: Todo[] = [
    {
      id: 'x',
      text: 'Release\n- [x] tag\n- [ ] build\n- [ ] publish',
      done: false,
      createdAt: NOW,
      tags: ['rel<1>'],
      due: addDays(dayOf(NOW), 1),
      agent: { terminalId: 't1', title: 'Fix <it>', sentAt: NOW, state: 'working', started: true }
    },
    { id: 'y', text: 'From inbox', done: false, createdAt: NOW, due: addDays(dayOf(NOW), -2), origin: 'agent', agent: { terminalId: 't2', title: 'Idle', sentAt: NOW, state: 'done' } }
  ]
  const html = list(stateOf({ todos }), NOW, KINDS)
  assert.ok(html.includes('data-act="tag" data-value="rel&lt;1&gt;"'))
  assert.ok(html.includes('#rel&lt;1&gt;</button>'))
  assert.ok(html.includes('class="meta-item due due-soon"') && html.includes('Tomorrow'))
  assert.ok(html.includes('class="meta-item due due-overdue"') && html.includes('2d overdue'))
  assert.ok(html.includes('title="1 of 3 done"') && html.includes('style="width:33%"') && html.includes('1/3'))
  assert.ok(html.includes('class="meta-item agent agent-working" title="Sent to Fix &lt;it&gt;"'))
  assert.ok(html.includes('<span class="agent-state">working</span>'))
  // An agent that was idle when it got the to-do is not reported as finished.
  assert.ok(html.includes('class="meta-item agent" title="Sent to Idle"'))
  assert.ok(html.includes('from an agent'))
})

test('a long to-do is folded until it is opened', () => {
  const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(isLong(long), true)
  assert.equal(isLong('short'), false)
  assert.equal(isLong('x'.repeat(600)), true)
  const todos: Todo[] = [{ id: 'l', text: long, done: false, createdAt: NOW }]
  const folded = list(stateOf({ todos }), NOW, KINDS)
  assert.ok(folded.includes('<div class="md folded">') && folded.includes('>Show more</button>'))
  const opened = list(stateOf({ todos, expanded: ['l'] }), NOW, KINDS)
  assert.ok(opened.includes('<div class="md">') && opened.includes('>Show less</button>'))
  assert.ok(!list(stateOf(), NOW, KINDS).includes('data-act="fold"'))
})

test('an archived to-do can only be restored or deleted', () => {
  const todos: Todo[] = [{ id: 'z', text: '- [ ] Old', done: true, createdAt: NOW, archivedAt: NOW }]
  const prefs = { ...DEFAULT_PREFS, view: 'archived' as const }
  const html = list(stateOf({ todos, prefs, row: { kind: 'menu', id: 'z' } }), NOW, KINDS)
  assert.ok(html.includes('data-act="restore" data-id="z"') && html.includes('data-act="delete" data-id="z"'))
  assert.ok(!html.includes('data-act="edit"') && !html.includes('data-act="done"') && !html.includes('draggable'))
  // Its task boxes are read-only.
  assert.ok(html.includes('disabled'))
  assert.ok(list(stateOf({ prefs }), NOW, KINDS).includes('Nothing archived'))
})

test('empty states say why nothing shows', () => {
  assert.ok(list(stateOf({ todos: [] }), NOW, KINDS).includes('No to-dos'))
  assert.ok(list(stateOf({ todos: [seed[1]] }), NOW, KINDS).includes('All done'))
  assert.ok(list(stateOf({ todos: [seed[0]], prefs: { ...DEFAULT_PREFS, view: 'done' } }), NOW, KINDS).includes('Nothing done yet'))
  assert.ok(list(stateOf({ search: 'zzz' }), NOW, KINDS).includes('No match'))
})

test('the slash menu lists the matching commands and marks the current one', () => {
  const html = slashMenu(matchSlash('list'), 1)
  assert.equal(count(html, 'class="menu-item slash-item"'), 3)
  assert.ok(html.includes('aria-selected="true" data-slash="1"'))
  assert.ok(html.includes('Numbered list') && html.includes('- [ ]'))
  assert.ok(slashMenu([], 0).includes('No match'))
})

test('the toast shows a message, escaped', () => {
  assert.equal(toast(stateOf()), '')
  const html = toast(stateOf({ toast: { tone: 'danger', text: 'a <b>' } }))
  assert.ok(html.includes('class="toast danger"') && html.includes('a &lt;b&gt;'))
  assert.ok(!html.includes('data-act="undo"'))
  assert.ok(toast(stateOf({ toast: { tone: 'neutral', text: 'Deleted.', undo: [] } })).includes('data-act="undo">Undo</button>'))
})
