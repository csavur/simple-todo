import { assert, test } from 'orca/testing'
import { addDays, exportJson, exportMarkdown, importFile, inboxInstructions, parseChecklist, parseQuickLine } from './transfer.ts'
import type { Todo } from './types.ts'

const TODAY = '2026-03-04'
const lists = [{ id: 'default', title: 'Home' }, { id: 'work', title: 'Work' }]
const todos: Todo[] = [
  { id: 'a', text: '# Ship it\n- [ ] tag\n- [x] build', done: false, createdAt: 1, project: 'web app', priority: 'high', tags: ['release'], due: '2026-03-05' },
  { id: 'b', text: 'Buy milk', done: true, createdAt: 2, doneAt: 3 },
  { id: 'c', text: 'Old', done: true, createdAt: 3, archivedAt: 4 },
  { id: 'd', text: 'Plan sprint', done: false, createdAt: 4, list: 'work' }
]
let counter = 0
const newId = () => `n${++counter}`

test('addDays steps over month ends', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('reads the markers of a quick-entry line', () => {
  assert.deepEqual(parseQuickLine('Fix login !high @web #bug #ui due:2026-03-09', TODAY), {
    text: 'Fix login',
    project: 'web',
    priority: 'high',
    tags: ['bug', 'ui'],
    due: '2026-03-09'
  })
  assert.deepEqual(parseQuickLine('Call Sam due:tomorrow', TODAY), { text: 'Call Sam', due: '2026-03-05' })
  // Not markers: an issue number, an unknown flag, a bad day, an email.
  assert.deepEqual(parseQuickLine('See #208 !soon due:friday a@b.c', TODAY), { text: 'See #208 !soon due:friday a@b.c' })
})

test('exports one list as a checklist that reads back as the same to-dos', () => {
  const markdown = exportMarkdown(todos, lists[0])
  assert.equal(
    markdown,
    '# Home\n\n- [ ] Ship it !high @web-app #release due:2026-03-05\n  - [ ] tag\n  - [x] build\n\n## Done\n\n- [x] Buy milk\n'
  )
  assert.deepEqual(parseChecklist(markdown, TODAY), [
    { text: 'Ship it\n- [ ] tag\n- [x] build', project: 'web-app', priority: 'high', tags: ['release'], due: '2026-03-05', done: false },
    { text: 'Buy milk', done: true }
  ])
  assert.equal(exportMarkdown([], lists[1]), '# Work\n\nNo to-dos.\n')
})

test('reads plain lines when there is no list', () => {
  assert.deepEqual(parseChecklist('# Notes\nBuy milk\n\nCall Sam !low\n', TODAY), [
    { text: 'Buy milk', done: false },
    { text: 'Call Sam', priority: 'low', done: false }
  ])
  assert.deepEqual(parseChecklist('', TODAY), [])
})

test('a backup comes back whole, once', () => {
  const backup = exportJson(todos, lists, 99)
  assert.equal(JSON.parse(backup).format, 'simple-todo')
  const fresh = importFile(backup, [], [lists[0]], 'default', newId, 100, TODAY)
  assert.deepEqual(fresh.todos, todos)
  assert.deepEqual(fresh.lists, [lists[1]])
  // Importing it again adds nothing.
  const again = importFile(backup, todos, lists, 'default', newId, 100, TODAY)
  assert.deepEqual(again, { todos: [], lists: [] })
})

test('a checklist is imported into the list being shown', () => {
  counter = 0
  const { todos: added, lists: newLists } = importFile('- [ ] One #a\n- [x] Two', [], lists, 'work', newId, 500, TODAY)
  assert.deepEqual(added, [
    { id: 'n1', createdAt: 500, text: 'One', tags: ['a'], done: false, list: 'work' },
    { id: 'n2', createdAt: 501, text: 'Two', done: true, doneAt: 500, list: 'work' }
  ])
  assert.deepEqual(newLists, [])
  // JSON that is not a backup is read as text, not trusted as data.
  assert.equal(importFile('{"todos":[{"id":"x","text":"y"}]}', [], lists, 'default', newId, 1, TODAY).todos.length, 1)
})

test('the agent instructions name the inbox file', () => {
  assert.ok(inboxInstructions('/home/me/.simple-todo/inbox.md').includes('/home/me/.simple-todo/inbox.md'))
})
