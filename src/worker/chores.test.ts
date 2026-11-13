import { assert, test } from 'orca/testing'
import type { AgentState, Todo } from '../core/types.ts'
import {
  applyAgentStates,
  autoArchive,
  DEFAULT_SETTINGS,
  dueReminder,
  inboxTodos,
  linkedTodos,
  parseSettings,
  promptOf
} from './chores.ts'

const TODAY = '2026-03-04'
const DAY = 86_400_000
const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, text: `Task ${id}`, done: false, createdAt: 0, ...extra })

test('settings fall back to their defaults', () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(parseSettings({ promptPrefix: 'Do:', autoComplete: true, archiveAfterDays: 3.9, dueReminders: false }), {
    promptPrefix: 'Do:',
    autoComplete: true,
    archiveAfterDays: 3,
    dueReminders: false
  })
  assert.equal(parseSettings({ archiveAfterDays: -1 }).archiveAfterDays, 14)
})

test('the prompt is the to-do, after the prefix when there is one', () => {
  assert.equal(promptOf('Fix it', DEFAULT_SETTINGS), 'Fix it')
  assert.equal(promptOf('Fix it', { ...DEFAULT_SETTINGS, promptPrefix: ' Work on this: ' }), 'Work on this:\n\nFix it')
})

test('reminds once for each due day, in one notification', () => {
  const list = [
    todo('a', { due: TODAY }),
    todo('b', { due: '2026-03-01' }),
    todo('c', { due: '2026-03-09' }),
    todo('d', { due: TODAY, done: true }),
    todo('e', { due: TODAY, archivedAt: 1 })
  ]
  const first = dueReminder(list, {}, TODAY)
  assert.deepEqual(first.reminder, { title: '2 to-dos due', body: 'Task a\nTask b' })
  assert.deepEqual(first.reminded, { a: TODAY, b: '2026-03-01' })
  // Told once: nothing more until a due day changes.
  assert.equal(dueReminder(list, first.reminded, TODAY).reminder, null)
  const moved = dueReminder([todo('a', { due: '2026-03-03' })], first.reminded, TODAY)
  assert.deepEqual(moved.reminder, { title: 'To-do overdue', body: 'Task a' })
  assert.deepEqual(dueReminder([todo('a', { due: TODAY })], {}, TODAY).reminder, { title: 'To-do due today', body: 'Task a' })
  // A finished to-do drops out of the record.
  assert.deepEqual(dueReminder([todo('a', { due: TODAY, done: true })], first.reminded, TODAY).reminded, {})
})

test('archives to-dos done long enough ago', () => {
  const now = 100 * DAY
  const list = [
    todo('old', { done: true, doneAt: now - 15 * DAY }),
    todo('recent', { done: true, doneAt: now - 2 * DAY }),
    todo('open'),
    todo('undated', { done: true })
  ]
  const archived = autoArchive(list, 14, now)
  assert.deepEqual(archived.map((t) => t.archivedAt), [now, undefined, undefined, undefined])
  assert.equal(autoArchive(list, 0, now), list)
  assert.equal(autoArchive(archived, 14, now), archived)
})

test('follows the agent a to-do was sent to', () => {
  const link = { terminalId: 't1', title: 'Fix', sentAt: 1 }
  const list = [todo('a', { agent: link }), todo('b')]
  const at = (state: AgentState) => new Map([['|t1', state]])
  const here = new Set([''])

  // Idle when it got the to-do: "done" does not finish it, even with auto-complete on.
  const idle = applyAgentStates(list, at('done'), here, true, 9)
  assert.deepEqual(idle[0].agent, { ...link, state: 'done' })
  assert.equal(idle[0].done, false)

  const working = applyAgentStates(idle, at('working'), here, true, 9)
  assert.deepEqual(working[0].agent, { ...link, state: 'working', started: true })
  assert.equal(applyAgentStates(working, at('working'), here, true, 9), working)

  const finished = applyAgentStates(working, at('done'), here, true, 9)
  assert.equal(finished[0].done, true)
  assert.equal(finished[0].doneAt, 9)
  assert.equal(applyAgentStates(working, at('done'), here, false, 9)[0].done, false)

  // Its terminal closed.
  assert.equal(applyAgentStates(working, new Map(), here, true, 9)[0].agent?.state, 'gone')
  // Its server did not answer: nothing is assumed.
  const remote = [todo('r', { agent: { ...link, environmentId: 'env', state: 'working', started: true } })]
  assert.equal(applyAgentStates(remote, new Map(), here, true, 9), remote)

  assert.deepEqual(linkedTodos([...working, todo('g', { agent: { ...link, state: 'gone' } }), todo('d', { agent: link, done: true })]).map((t) => t.id), ['a'])
})

test('reads the inbox into to-dos marked as coming from an agent', () => {
  let n = 0
  const added = inboxTodos('- [ ] Review the PR !high #review @web due:tomorrow\nnot a list item\n- Plain item\n', 'work', () => `i${++n}`, 50, TODAY)
  assert.deepEqual(added, [
    { text: 'Review the PR', project: 'web', priority: 'high', tags: ['review'], due: '2026-03-05', done: false, id: 'i1', createdAt: 50, list: 'work', origin: 'agent' },
    { text: 'Plain item', done: false, id: 'i2', createdAt: 51, list: 'work', origin: 'agent' }
  ])
  assert.deepEqual(inboxTodos('', 'default', () => 'x', 1, TODAY), [])
})
