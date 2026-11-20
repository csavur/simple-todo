import { assert, test } from 'orca/testing'
import type { Todo } from './types.ts'
import { parseNote, renderItem, renderNote, safeName, syncVault, type VaultBase, type VaultFile, type VaultSyncInput } from './vault.ts'

const TODAY = '2026-03-04'
const NOW = 1_000_000
const lists = [
  { id: 'default', title: 'Home' },
  { id: 'work', title: 'Work' }
]
const todos: Todo[] = [
  { id: 'a', text: 'Fix login\n  details here', done: false, createdAt: 1, project: 'web app', priority: 'high', tags: ['bug'], due: '2026-03-05' },
  { id: 'b', text: 'Buy milk', done: true, createdAt: 2, doneAt: 3 },
  { id: 'c', text: 'Old', done: true, createdAt: 3, doneAt: 4, archivedAt: 5 },
  {
    id: 'd',
    text: 'Plan sprint',
    done: false,
    createdAt: 4,
    list: 'work',
    origin: 'agent',
    agent: { terminalId: 't1', title: 'Claude', sentAt: 9, state: 'working' }
  }
]

function ids(): () => string {
  let n = 0
  return () => `new${++n}`
}

function run(over: Partial<VaultSyncInput>): ReturnType<typeof syncVault> {
  return syncVault({ folder: '/v', todos, lists, files: [], base: null, newId: ids(), now: NOW, today: TODAY, ...over })
}

/** A first sync into an empty folder, and the folder it leaves. */
function first(): { files: VaultFile[]; base: VaultBase } {
  const result = run({})
  return { files: result.writes, base: result.base }
}

function edit(files: VaultFile[], name: string, change: (text: string) => string): VaultFile[] {
  return files.map((file) => (file.name === name ? { name, text: change(file.text) } : file))
}

test('a first sync writes one note per list, open then done then archived', () => {
  const result = run({})
  assert.deepEqual(result.writes.map((file) => file.name), ['Home.md', 'Work.md'])
  assert.deepEqual(result.deletes, [])
  assert.equal(
    result.writes[0].text,
    [
      '---',
      'simple-todo-list: default',
      '---',
      '',
      '- [ ] Fix login !high @web-app #bug due:2026-03-05 %%id:a created:1%%',
      '    details here',
      '',
      '## Done',
      '',
      '- [x] Buy milk %%id:b created:2 done:3%%',
      '',
      '## Archived',
      '',
      '- [x] Old %%id:c created:3 done:4 archived:5%%',
      ''
    ].join('\n')
  )
  assert.ok(result.writes[1].text.includes('- [ ] Plan sprint %%id:d created:4 from:agent%%'))
  assert.deepEqual(result.todos, todos)
})

test('a note reads back as the same items, and nothing changes on the next sync', () => {
  const { files, base } = first()
  const note = parseNote(files[0].text)
  assert.equal(note.listId, 'default')
  assert.deepEqual(note.items.map((item) => [item.meta.id, item.checked, item.archived]), [
    ['a', false, false],
    ['b', true, false],
    ['c', true, true]
  ])
  assert.equal(note.items[0].block, renderItem(todos[0]))
  const again = run({ files, base })
  assert.deepEqual(again.writes, [])
  assert.deepEqual(again.deletes, [])
  assert.deepEqual(again.todos, todos)
})

test('a box ticked in the vault marks the to-do done, and keeps its agent link', () => {
  const { files, base } = first()
  const ticked = edit(files, 'Work.md', (text) => text.replace('- [ ] Plan sprint', '- [x] Plan sprint'))
  const result = run({ files: ticked, base })
  const sprint = result.todos.find((todo) => todo.id === 'd')
  assert.equal(sprint?.done, true)
  assert.equal(sprint?.doneAt, NOW)
  assert.equal(sprint?.agent?.terminalId, 't1')
  assert.equal(sprint?.origin, 'agent')
  // Rewritten under "Done", with the time it was done.
  assert.ok(result.writes[0].text.includes('## Done\n\n- [x] Plan sprint %%id:d created:4 done:1000000 from:agent%%'))
})

test('a line typed in the vault is a new to-do, with its markers read', () => {
  const { files, base } = first()
  const typed = edit(files, 'Work.md', (text) => `${text}Call the bank !urgent #money due:tomorrow\n- [ ] Book flights\n`)
  const result = run({ files: typed, base })
  const added = result.todos.filter((todo) => todo.id.startsWith('new'))
  assert.deepEqual(
    added.map((todo) => [todo.id, todo.text, todo.priority, todo.tags, todo.due, todo.list, todo.createdAt]),
    [
      ['new1', 'Call the bank', 'urgent', ['money'], '2026-03-05', 'work', NOW],
      ['new2', 'Book flights', undefined, undefined, undefined, 'work', NOW + 1]
    ]
  )
  assert.ok(result.writes[0].text.includes('- [ ] Call the bank !urgent #money due:2026-03-05 %%id:new1 created:1000000%%'))
})

test('a change in the plugin rewrites the note; a line removed in the vault removes the to-do', () => {
  const { files, base } = first()
  const changed = todos.map((todo) => (todo.id === 'b' ? { ...todo, text: 'Buy oat milk' } : todo))
  const written = run({ todos: changed, files, base })
  assert.equal(written.writes.length, 1)
  assert.ok(written.writes[0].text.includes('Buy oat milk'))

  const removed = edit(files, 'Home.md', (text) => text.replace(/- \[x\] Buy milk.*\n/, ''))
  const result = run({ files: removed, base })
  assert.deepEqual(result.todos.map((todo) => todo.id), ['a', 'c', 'd'])
})

test('a to-do removed in the plugin leaves the note; one changed on both sides keeps the plugin side', () => {
  const { files, base } = first()
  const removed = run({ todos: todos.filter((todo) => todo.id !== 'b'), files, base })
  assert.deepEqual(removed.todos.map((todo) => todo.id), ['a', 'c', 'd'])
  assert.ok(!removed.writes[0].text.includes('Buy milk'))

  const both = run({
    todos: todos.map((todo) => (todo.id === 'b' ? { ...todo, text: 'Buy bread' } : todo)),
    files: edit(files, 'Home.md', (text) => text.replace('Buy milk', 'Buy eggs')),
    base
  })
  assert.equal(both.todos.find((todo) => todo.id === 'b')?.text, 'Buy bread')
  assert.equal(both.notes.length, 1)
})

test('to-dos from another machine are added, and a project keeps its spaces', () => {
  const { files } = first()
  const result = run({ todos: [], lists: [{ id: 'default', title: 'Home' }], files, base: null })
  assert.deepEqual(result.lists, lists)
  const fix = result.todos.find((todo) => todo.id === 'a')
  assert.equal(fix?.project, 'web-app')
  assert.equal(fix?.text, 'Fix login\n  details here')
  assert.equal(result.todos.find((todo) => todo.id === 'c')?.archivedAt, 5)
  assert.equal(result.todos.find((todo) => todo.id === 'd')?.agent, undefined)

  const { files: again, base } = first()
  const edited = run({ files: edit(again, 'Home.md', (text) => text.replace('Fix login', 'Fix the login')), base })
  assert.equal(edited.todos.find((todo) => todo.id === 'a')?.project, 'web app')
})

test('lists: renamed in the plugin or the vault, removed in either, added in either', () => {
  const { files, base } = first()

  const renamed = run({ lists: [lists[0], { id: 'work', title: 'Job' }], files, base })
  assert.deepEqual(renamed.deletes, ['Work.md'])
  assert.deepEqual(renamed.writes.map((file) => file.name), ['Job.md'])

  const movedThere = run({ files: files.map((file) => (file.name === 'Work.md' ? { ...file, name: 'Office.md' } : file)), base })
  assert.deepEqual(movedThere.lists, [lists[0], { id: 'work', title: 'Office' }])
  assert.deepEqual(movedThere.writes, [])

  const removedThere = run({ files: files.filter((file) => file.name !== 'Work.md'), base })
  assert.deepEqual(removedThere.lists, [lists[0]])
  assert.deepEqual(removedThere.todos.map((todo) => todo.id), ['a', 'b', 'c'])

  const removedHere = run({ lists: [lists[0]], todos: todos.filter((todo) => todo.list !== 'work'), files, base })
  assert.deepEqual(removedHere.deletes, ['Work.md'])
  assert.deepEqual(removedHere.lists, [lists[0]])

  const added = run({
    files: [...files, { name: 'Ideas.md', text: '---\nsimple-todo-list: ideas\n---\n\n- [ ] Write a book\n' }],
    base
  })
  assert.deepEqual(added.lists.at(-1), { id: 'ideas', title: 'Ideas' })
  assert.equal(added.todos.at(-1)?.list, 'ideas')
})

test('the first list is never removed, and an empty folder that had lists is left alone', () => {
  const { files, base } = first()
  const result = run({ files: files.filter((file) => file.name !== 'Home.md'), base })
  assert.deepEqual(result.lists, lists)
  assert.deepEqual(result.writes.map((file) => file.name), ['Home.md'])

  const empty = run({ files: [], base })
  assert.deepEqual(empty.writes, [])
  assert.deepEqual(empty.todos, todos)
  assert.equal(empty.notes.length, 1)
})

test('notes that are not lists are never touched, and names never collide with them', () => {
  const mine = { name: 'Home.md', text: '# My home note\n\n- [ ] not a to-do of the plugin\n' }
  const result = run({ files: [mine] })
  assert.deepEqual(result.writes.map((file) => file.name), ['Home (2).md', 'Work.md'])
  assert.equal(result.todos.length, todos.length)
  assert.equal(safeName('a/b: c?'), 'a-b- c-')
})

test('frontmatter and text above the to-dos are kept', () => {
  const source = '---\ntags: [todo]\nsimple-todo-list: work\n---\nSome notes\n\n- [ ] One %%id:x created:1%%\n'
  const note = parseNote(source)
  assert.deepEqual(note.frontmatter, ['tags: [todo]'])
  assert.equal(note.preamble, 'Some notes')
  assert.equal(
    renderNote('work', [{ id: 'x', text: 'One', done: false, createdAt: 1, list: 'work' }], note),
    '---\nsimple-todo-list: work\ntags: [todo]\n---\n\nSome notes\n\n- [ ] One %%id:x created:1%%\n'
  )
})
