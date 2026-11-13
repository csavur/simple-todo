import { assert, test } from 'orca/testing'
import {
  cleanTags,
  dayOf,
  daysBetween,
  dueLabel,
  dueStatus,
  listOf,
  parseTodos,
  projectsOf,
  sortByPriority,
  statusBarOf,
  summaryOf,
  tagsOf,
  taskProgress,
  titleOf,
  withDone
} from './todos.ts'
import type { Todo } from './types.ts'

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  text: `Task ${id}`,
  done: false,
  createdAt: 0,
  ...extra
})

test('parseTodos keeps well-formed tasks and drops the rest', () => {
  assert.deepEqual(parseTodos('nope'), [])
  assert.deepEqual(
    parseTodos([
      { id: 'a', text: 'A', done: true, createdAt: 5, project: 'orca', priority: 'urgent' },
      { id: 'b', text: 'B', priority: 'bogus', project: '' },
      { text: 'no id' },
      null
    ]),
    [
      { id: 'a', text: 'A', done: true, createdAt: 5, project: 'orca', priority: 'urgent' },
      { id: 'b', text: 'B', done: false, createdAt: 0 }
    ]
  )
})

test('sortByPriority puts the most pressing first, then the oldest', () => {
  const sorted = sortByPriority([
    todo('plain', { createdAt: 1 }),
    todo('low', { priority: 'low' }),
    todo('urgent-new', { priority: 'urgent', createdAt: 9 }),
    todo('high', { priority: 'high' }),
    todo('urgent-old', { priority: 'urgent', createdAt: 2 }),
    todo('medium', { priority: 'medium' })
  ])
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['urgent-old', 'urgent-new', 'high', 'medium', 'low', 'plain']
  )
})

test('projectsOf lists each tag once, sorted', () => {
  const list = [todo('a', { project: 'web' }), todo('b'), todo('c', { project: 'api' }), todo('d', { project: 'web' })]
  assert.deepEqual(projectsOf(list), ['api', 'web'])
})

test('titleOf is the first line without Markdown markers', () => {
  assert.equal(titleOf(todo('a', { text: '\n## **Release** `v2`\n- tag' })), 'Release v2')
  assert.equal(titleOf(todo('a', { text: '- [ ] buy milk' })), 'buy milk')
  assert.equal(titleOf(todo('a', { text: 'x'.repeat(80) })).length, 60)
})

test('statusBarOf counts open tasks and flags urgent ones', () => {
  assert.equal(statusBarOf([todo('a', { done: true })]).visible, false)
  assert.deepEqual(statusBarOf([todo('a'), todo('b', { done: true })]), {
    visible: true,
    text: '1 to-do',
    tone: 'neutral',
    tooltip: 'Next: Task a'
  })
  assert.deepEqual(statusBarOf([todo('a'), todo('b', { priority: 'urgent' })]), {
    visible: true,
    text: '2 to-dos, 1 urgent',
    tone: 'danger',
    tooltip: 'Next: Task b'
  })
})

test('summaryOf lists open tasks, most pressing first', () => {
  assert.equal(summaryOf([]), 'No open to-dos.')
  assert.equal(
    summaryOf([todo('a', { project: 'web' }), todo('b', { priority: 'high' }), todo('c', { done: true })]),
    '- [High] Task b\n- Task a (web)'
  )
  const many = Array.from({ length: 12 }, (_, i) => todo(String(i), { createdAt: i }))
  assert.ok(summaryOf(many).endsWith('...and 2 more'))
})

test('parseTodos keeps the newer fields when they are well formed', () => {
  const full = {
    id: 'a',
    text: 'A',
    done: true,
    createdAt: 1,
    tags: ['#bug', 'bug', ' two words ', 7, ''],
    due: '2026-03-04',
    doneAt: 9,
    archivedAt: 10,
    list: 'work',
    agent: { terminalId: 't1', environmentId: 'env', title: 'Fix', sentAt: 5, state: 'working', started: true },
    origin: 'agent'
  }
  assert.deepEqual(parseTodos([full]), [
    { ...full, tags: ['bug', 'two-words'] }
  ])
  assert.deepEqual(
    parseTodos([{ id: 'b', text: 'B', due: 'soon', tags: [], list: 'default', agent: { title: 'x' }, origin: 'me', doneAt: 'x' }]),
    [{ id: 'b', text: 'B', done: false, createdAt: 0 }]
  )
  assert.deepEqual(parseTodos([{ id: 'c', text: 'C', agent: { terminalId: 't', state: 'odd' } }])[0].agent, {
    terminalId: 't',
    title: 'Agent',
    sentAt: 0
  })
})

test('parseTodos reads a leftover agent mention as plain text', () => {
  assert.equal(parseTodos([{ id: 'a', text: 'Ask [@Fix login](agent:env-1/term_a) first' }])[0].text, 'Ask @Fix login first')
})

test('cleanTags and tagsOf tidy and collect tags', () => {
  assert.deepEqual(cleanTags(['#a', 'A', ' b c ', '##d', '']), ['a', 'b-c', 'd'])
  assert.deepEqual(tagsOf([todo('1', { tags: ['idea', 'Bug'] }), todo('2', { tags: ['bug'] }), todo('3')]), ['Bug', 'idea'])
})

test('withDone records and clears when a task was finished', () => {
  assert.deepEqual(withDone(todo('a'), true, 50), { ...todo('a'), done: true, doneAt: 50 })
  assert.deepEqual(withDone({ ...todo('a'), done: true, doneAt: 50 }, false, 60), todo('a'))
  assert.equal(listOf(todo('a')), 'default')
  assert.equal(listOf(todo('a', { list: 'work' })), 'work')
})

test('days: local day, distance, status and label', () => {
  assert.equal(dayOf(new Date(2026, 2, 4, 23, 59).getTime()), '2026-03-04')
  assert.equal(daysBetween('2026-03-04', '2026-03-06'), 2)
  assert.equal(daysBetween('2026-03-04', '2026-02-28'), -4)
  // Across a clock change the count is still whole days.
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2)
  const today = '2026-03-04' // a Wednesday
  assert.equal(dueStatus('2026-03-03', today), 'overdue')
  assert.equal(dueStatus(today, today), 'today')
  assert.equal(dueStatus('2026-03-11', today), 'soon')
  assert.equal(dueStatus('2026-03-12', today), 'later')
  assert.equal(dueLabel('2026-03-01', today), '3d overdue')
  assert.equal(dueLabel(today, today), 'Today')
  assert.equal(dueLabel('2026-03-05', today), 'Tomorrow')
  assert.equal(dueLabel('2026-03-07', today), 'Sat')
  assert.equal(dueLabel('2026-03-20', today), 'Mar 20')
  assert.equal(dueLabel('2027-01-02', today), 'Jan 2, 2027')
})

test('taskProgress counts task boxes outside code blocks', () => {
  assert.deepEqual(taskProgress('Title\n- [x] a\n- [ ] b\n1. [X] c\n```\n- [ ] no\n```\n- plain'), { done: 2, total: 3 })
  assert.deepEqual(taskProgress('no boxes'), { done: 0, total: 0 })
})

test('the status bar ignores archived tasks and flags overdue ones', () => {
  const list = [todo('a', { due: '2026-03-01' }), todo('b', { archivedAt: 5 }), todo('c', { done: true })]
  assert.equal(statusBarOf(list, '2026-03-04').text, '1 to-do, 1 overdue')
  assert.equal(statusBarOf(list, '2026-03-04').tone, 'danger')
  assert.equal(statusBarOf(list).text, '1 to-do')
  assert.equal(summaryOf([todo('b', { archivedAt: 5 })]), 'No open to-dos.')
})
