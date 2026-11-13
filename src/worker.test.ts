// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { atom, Button, h, update } from 'orca'
import { assert, hostError, mockHost, mount, mountWorker, test } from 'orca/testing'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillText } from './core/skill.ts'
import { createWorker, groupProjects } from './worker.ts'
import type { InboxFile } from './worker/files.ts'
import { terminalIn } from './worker/agents.ts'
import type { OrcaCli } from './worker/cli.ts'

/** Every CLI call the worker made, and a stand-in CLI with one paired server. */
let cliCalls: string[][] = []
const cli: OrcaCli = async (args) => {
  cliCalls.push([...args])
  switch (`${args[0]} ${args[1]}`) {
    case 'environment list':
      return { environments: [{ id: 'env-1', name: 'build-box' }] }
    case 'repo list':
      return {
        repos: [
          { id: 'r1', displayName: 'web' },
          { id: 'r2', displayName: 'infra' },
          { id: 'r3', displayName: 'empty' }
        ]
      }
    case 'terminal list':
      return args.includes('--environment=env-1')
        ? {
            terminals: [
              { handle: 'term_r1', title: 'Rotate keys', agentIdentity: 'claude', worktreeId: 'r2::/srv/infra', connected: true, writable: true },
              { handle: 'term_r2', title: 'bash', agentIdentity: null, worktreeId: 'r2::/srv/infra' }
            ]
          }
        : {
            terminals: [
              { handle: 'term_l1', title: 'Fix login', agentIdentity: 'codex', worktreeId: 'w2' },
              { handle: 'term_l2', title: '', agentIdentity: 'claude', worktreeId: null },
              { handle: 'term_l3', title: 'Detached', agentIdentity: 'claude', worktreeId: 'w1', orphaned: true },
              { handle: 'term_l4', title: 'Read only', agentIdentity: 'claude', worktreeId: 'w1', writable: false }
            ]
          }
    case 'worktree list':
      return {
        worktrees: [
          { id: 'r1::/srv/web-hotfix', repoId: 'r1', displayName: 'hotfix', branch: 'refs/heads/hotfix' },
          { id: 'r2::/srv/infra-x', repoId: 'r2', displayName: 'x', branch: 'refs/heads/x' },
          { id: 'r2::/srv/infra', repoId: 'r2', displayName: 'main', branch: 'refs/heads/main', isMainWorktree: true },
          { id: 'r2::/srv/infra-old', repoId: 'r2', displayName: 'old', branch: null, isArchived: true }
        ]
      }
    default:
      return {}
  }
}
/** A stand-in for the inbox file on disk. */
function fakeInbox(text = ''): InboxFile & { text: string } {
  return {
    path: '/home/me/.simple-todo/inbox.md',
    text,
    async take() {
      const taken = this.text
      this.text = ''
      return taken
    }
  }
}

// Never the real CLI, the real disk or real timers: tests must not reach this machine's Orca.
const quiet = { inbox: fakeInbox(), timers: false }
const main = createWorker(cli, quiet)

const todos: Record<string, string | number | boolean>[] = [
  { id: 'a', text: 'Write docs', done: false, createdAt: 1, priority: 'urgent' },
  { id: 'b', text: 'Ship it', done: true, createdAt: 2 }
]

const workspaces = [
  { id: 'w2', kind: 'worktree', name: 'fix-login', project: 'web', path: '/w/web-fix', branch: 'fix-login', hostId: null },
  { id: 'w1', kind: 'worktree', name: 'web', project: 'web', path: '/w/web', branch: 'main', hostId: null },
  { id: 'f1', kind: 'folder', name: 'notes', project: null, path: '/w/notes', branch: null, hostId: null }
]

/** The last statusBar.update the worker made. */
function lastBar(host: ReturnType<typeof mockHost>): unknown {
  return host.callsOf('statusBar.update').at(-1)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('groupProjects groups workspaces by the project Orca names', () => {
  assert.deepEqual(
    groupProjects(workspaces as Parameters<typeof groupProjects>[0]),
    [
      { name: 'notes', workspaces: [{ id: 'f1', kind: 'folder', name: 'notes', branch: null }] },
      {
        name: 'web',
        workspaces: [
          { id: 'w2', kind: 'worktree', name: 'fix-login', branch: 'fix-login' },
          { id: 'w1', kind: 'worktree', name: 'web', branch: 'main' }
        ]
      }
    ]
  )
})

test('shows open tasks in the status bar and follows the stored list', async () => {
  const host = mockHost({ storage: { todos } })
  const worker = await mountWorker(main, { host })
  await settle()
  assert.deepEqual(lastBar(host), {
    id: 'open',
    visible: true,
    text: '1 to-do, 1 urgent',
    tone: 'danger',
    tooltip: 'Next: Write docs'
  })

  // Something else on the same host (the panel) rewrites the stored list: the worker follows.
  const stored = atom<unknown>('todos', [], { persist: 'storage' })
  const panel = await mount(
    () => h(Button, { onPress: () => update(stored, () => []) }, 'Clear'),
    { host }
  )
  await panel.press({ text: 'Clear' })
  await settle()
  assert.deepEqual(lastBar(host), { id: 'open', visible: false })
  assert.deepEqual(worker.refusals, [])
  await panel.unmount()
  await worker.deactivate()
})

test('the command summarises open tasks', async () => {
  const worker = await mountWorker(main, { host: mockHost({ storage: { todos } }) })
  assert.equal(await worker.command('simple-todo.summary'), '- [Urgent] Write docs')
  await worker.deactivate()
})

test('lists local and paired-server projects together', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces, truncated: false } } })
  const worker = await mountWorker(main, { host })
  const listed = await worker.request('projects.list')
  assert.ok(listed.ok)
  const server = { id: 'env-1', name: 'build-box' }
  assert.deepEqual(listed.projects, [
    {
      name: 'infra',
      workspaces: [
        { id: 'r2::/srv/infra', kind: 'worktree', name: 'main', branch: 'main', environment: server },
        { id: 'r2::/srv/infra-x', kind: 'worktree', name: 'x', branch: 'x', environment: server }
      ]
    },
    { name: 'notes', workspaces: [{ id: 'f1', kind: 'folder', name: 'notes', branch: null }] },
    {
      // The same project here and on the server is one project.
      name: 'web',
      workspaces: [
        { id: 'w2', kind: 'worktree', name: 'fix-login', branch: 'fix-login' },
        { id: 'w1', kind: 'worktree', name: 'web', branch: 'main' },
        { id: 'r1::/srv/web-hotfix', kind: 'worktree', name: 'hotfix', branch: 'hotfix', environment: server }
      ]
    }
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('still lists local projects when a paired server cannot be reached', async () => {
  const failing: OrcaCli = async (args) => {
    if (args[0] === 'environment') {
      return { environments: [{ id: 'env-1', name: 'build-box' }] }
    }
    throw new Error('tunnel is down')
  }
  const host = mockHost({ results: { 'workspace.list': { workspaces, truncated: false } } })
  const worker = await mountWorker(createWorker(failing, quiet), { host })
  const listed = await worker.request('projects.list')
  assert.ok(listed.ok)
  assert.deepEqual(listed.projects.map((p) => p.name), ['notes', 'web'])
  assert.ok(worker.logs.some((line) => line.includes('build-box') && line.includes('tunnel is down')))
  await worker.deactivate()
})

test('opens a local workspace through the host and a remote one through the CLI', async () => {
  cliCalls = []
  const host = mockHost({ results: { 'workspace.open': { opened: true } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('workspace.open', { workspaceId: 'w1' }), { ok: true })
  assert.deepEqual(host.callsOf('workspace.open')[0], { workspaceId: 'w1' })
  assert.deepEqual(cliCalls, [])

  assert.deepEqual(
    await worker.request('workspace.open', { workspaceId: 'r2::/srv/infra', environmentId: 'env-1' }),
    { ok: true }
  )
  assert.equal(host.callsOf('workspace.open').length, 1)
  assert.deepEqual(cliCalls, [
    ['worktree', 'activate', '--environment=env-1', '--worktree=id:r2::/srv/infra']
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('starts an agent on a paired server through the CLI', async () => {
  cliCalls = []
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  assert.deepEqual(
    await worker.request('agent.launch', {
      workspaceId: 'r2::/srv/infra',
      environmentId: 'env-1',
      agent: 'codex',
      prompt: '- [ ] Rotate keys'
    }),
    { ok: true }
  )
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(cliCalls, [
    [
      'agent',
      'launch',
      '--environment=env-1',
      '--worktree=id:r2::/srv/infra',
      '--agent=codex',
      '--prompt=- [ ] Rotate keys'
    ]
  ])
  await worker.deactivate()
})

test('lists agents running in a terminal, here and on a paired server', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('agents.list'), {
    ok: true,
    agents: [
      { terminalId: 'term_l1', title: 'Fix login', agent: 'codex', workspaceId: 'w2' },
      // No title yet: named after the agent. No workspace: still listed.
      { terminalId: 'term_l2', title: 'claude', agent: 'claude', workspaceId: null },
      {
        terminalId: 'term_r1',
        title: 'Rotate keys',
        agent: 'claude',
        workspaceId: 'r2::/srv/infra',
        environment: { id: 'env-1', name: 'build-box' }
      }
    ]
  })
  await worker.deactivate()
})

test('still lists local agents when a paired server cannot be reached', async () => {
  const failing: OrcaCli = async (args) => {
    if (args.some((arg) => arg.startsWith('--environment='))) {
      throw new Error('tunnel is down')
    }
    return cli(args)
  }
  const worker = await mountWorker(createWorker(failing, quiet), { host: mockHost() })
  const listed = await worker.request('agents.list')
  assert.ok(listed.ok)
  assert.deepEqual(listed.agents.map((agent) => agent.terminalId), ['term_l1', 'term_l2'])
  assert.ok(worker.logs.some((line) => line.includes('build-box')))
  await worker.deactivate()
})

test('sends a task to a running agent, here or on a paired server', async () => {
  cliCalls = []
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('agent.send', { terminalId: 'term_l1', prompt: '- do it' }), { ok: true })
  assert.deepEqual(
    await worker.request('agent.send', { terminalId: 'term_r1', environmentId: 'env-1', prompt: 'Do it' }),
    { ok: true }
  )
  assert.deepEqual(cliCalls, [
    ['terminal', 'send', '--terminal=term_l1', '--text=- do it', '--enter'],
    ['terminal', 'send', '--terminal=term_r1', '--environment=env-1', '--text=Do it', '--enter']
  ])
  await worker.deactivate()
})

test('starts a local agent through the host', async () => {
  cliCalls = []
  const host = mockHost({ results: { 'agent.launch': { terminalId: 't9' } } })
  const worker = await mountWorker(main, { host })
  // The terminal comes back, so the to-do can follow its agent.
  assert.deepEqual(
    await worker.request('agent.launch', { workspaceId: 'w1', agent: 'codex', prompt: 'Do it' }),
    { ok: true, terminalId: 't9' }
  )
  assert.deepEqual(host.callsOf('agent.launch')[0], { workspaceId: 'w1', agent: 'codex', prompt: 'Do it' })
  assert.deepEqual(cliCalls, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reports a failed action as a message', async () => {
  const failing: OrcaCli = async () => {
    throw new Error('terminal is gone')
  }
  const host = mockHost({
    results: {
      'agent.launch': () => {
        throw hostError('action_failed', 'no such agent')
      }
    }
  })
  const worker = await mountWorker(createWorker(failing, quiet), { host })
  assert.deepEqual(await worker.request('agent.send', { terminalId: 't1', prompt: 'Do it' }), {
    ok: false,
    error: 'terminal is gone'
  })
  const launched = await worker.request('agent.launch', { workspaceId: 'w1', agent: 'nope', prompt: 'Do it' })
  assert.equal(launched.ok, false)
  await worker.deactivate()
})

test('puts the prefix from the settings before a to-do sent to an agent', async () => {
  cliCalls = []
  const host = mockHost({
    settings: { promptPrefix: 'Work on this:' },
    results: { 'agent.launch': { terminalId: 't9' } }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('agent.send', { terminalId: 'term_l1', prompt: 'Fix it' })
  assert.deepEqual(cliCalls.at(-1), ['terminal', 'send', '--terminal=term_l1', '--text=Work on this:\n\nFix it', '--enter'])
  await worker.request('agent.launch', { workspaceId: 'w1', agent: 'claude', prompt: 'Fix it' })
  assert.equal((host.callsOf('agent.launch')[0] as { prompt: string }).prompt, 'Work on this:\n\nFix it')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('finds the terminal a remote launch answers with', async () => {
  assert.equal(terminalIn({ outcome: { kind: 'terminal', terminal: { handle: 'term_ab-12' } } }), 'term_ab-12')
  assert.equal(terminalIn({ note: 'terminal started', ids: ['x'] }), undefined)
  const launching: OrcaCli = async (args) => (args[0] === 'agent' ? { terminal: { handle: 'term_new' } } : cli(args))
  const worker = await mountWorker(createWorker(launching, quiet), { host: mockHost() })
  assert.deepEqual(
    await worker.request('agent.launch', { workspaceId: 'r2::/srv/infra', environmentId: 'env-1', agent: 'codex', prompt: 'x' }),
    { ok: true, terminalId: 'term_new' }
  )
  await worker.deactivate()
})

test('the quick-add command opens the panel and tells it to show the form', async () => {
  cliCalls = []
  const listing: OrcaCli = async (args) => {
    cliCalls.push([...args])
    return args[1] === 'list'
      ? { plugins: [{ pluginKey: 'someone.simple-todo' }, { pluginKey: 'local.simple-todo', isDev: true }, { pluginKey: 'x.other' }] }
      : {}
  }
  const worker = await mountWorker(createWorker(listing, quiet), { host: mockHost() })
  assert.deepEqual(await worker.request('compose.take'), { pending: false })
  assert.equal(await worker.command('simple-todo.quickAdd'), '')
  assert.deepEqual(worker.posts, [{ event: 'compose', payload: {} }])
  // The development copy is the one running.
  assert.deepEqual(cliCalls.at(-1), ['plugin', 'open', 'local.simple-todo', '--panel=simple-todo'])
  // A panel that was not open yet learns of it as it loads, once.
  assert.deepEqual(await worker.request('compose.take'), { pending: true })
  assert.deepEqual(await worker.request('compose.take'), { pending: false })
  await worker.deactivate()
})

test('takes to-dos from the inbox file into the list being shown, and empties it', async () => {
  const inbox = fakeInbox('- [ ] Review the PR !high #review\n- Second thing\n')
  const host = mockHost({ storage: { todos, prefs: { list: 'work', lists: [{ id: 'work', title: 'Work' }] } } })
  const handle = createWorker(cli, { inbox, timers: false })
  const worker = await mountWorker(handle, { host })
  assert.deepEqual(await worker.request('inbox.path'), { path: '/home/me/.simple-todo/inbox.md' })
  await handle.look()
  const stored = host.data().storage.todos as unknown as { text: string; list?: string; origin?: string; priority?: string; tags?: string[] }[]
  assert.equal(stored.length, 4)
  assert.deepEqual(
    stored.slice(2).map(({ text, list, origin, priority, tags }) => ({ text, list, origin, priority, tags })),
    [
      { text: 'Review the PR', list: 'work', origin: 'agent', priority: 'high', tags: ['review'] },
      { text: 'Second thing', list: 'work', origin: 'agent', priority: undefined, tags: undefined }
    ]
  )
  assert.equal(inbox.text, '')
  // Nothing new: nothing is added twice.
  await handle.look()
  assert.equal((host.data().storage.todos as unknown[]).length, 4)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('keeps the agent skill installed while the setting is on, and removes it when turned off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'simple-todo-'))
  const file = join(home, '.agents', 'skills', 'simple-todo', 'SKILL.md')
  let agentSkill = true
  const host = mockHost({ storage: { todos }, results: { 'settings.get': () => ({ settings: { agentSkill } }) } })
  const handle = createWorker(cli, { inbox: fakeInbox(), timers: false, skillHome: home })
  const worker = await mountWorker(handle, { host })
  await handle.look()
  assert.equal(await readFile(file, 'utf8'), skillText())
  assert.equal(host.data().storage.skill, skillText())
  agentSkill = false
  await handle.look()
  await assert.rejects(readFile(file, 'utf8'))
  assert.equal(host.data().storage.skill, undefined)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('follows the agent a to-do was sent to, and finishes the to-do when the setting says so', async () => {
  let state = 'working'
  const watching: OrcaCli = async (args) => {
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return { worktrees: [{ agents: [{ paneKey: 'tab1:leaf1', state }] }] }
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return { terminals: [{ handle: 'term_a', tabId: 'tab1', leafId: 'leaf1', agentIdentity: 'claude' }] }
    }
    return {}
  }
  const linked = [{ id: 'a', text: 'Fix it', done: false, createdAt: 1, agent: { terminalId: 'term_a', title: 'Fix', sentAt: 2 } }]
  const host = mockHost({ storage: { todos: linked as never }, settings: { autoComplete: true } })
  const handle = createWorker(watching, quiet)
  const worker = await mountWorker(handle, { host })
  const stored = () => (host.data().storage.todos as unknown as { done: boolean; agent: { state?: string; started?: boolean } }[])[0]

  await handle.look()
  assert.deepEqual([stored().agent.state, stored().agent.started, stored().done], ['working', true, false])
  state = 'done'
  await handle.look()
  assert.deepEqual([stored().agent.state, stored().done], ['done', true])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reminds of a due to-do once, and archives old done ones', async () => {
  const now = Date.now()
  const day = (offset: number) => {
    const date = new Date(now + offset * 86_400_000)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const list = [
    { id: 'due', text: 'Pay the invoice', done: false, createdAt: 1, due: day(0) },
    { id: 'old', text: 'Long finished', done: true, createdAt: 1, doneAt: now - 30 * 86_400_000 }
  ]
  const host = mockHost({ storage: { todos: list as never } })
  const handle = createWorker(cli, quiet)
  const worker = await mountWorker(handle, { host })
  await handle.look()
  assert.deepEqual(host.callsOf('notifications.show'), [{ title: 'To-do due today', body: 'Pay the invoice' }])
  const stored = host.data().storage.todos as unknown as { id: string; archivedAt?: number }[]
  assert.equal(typeof stored.find((todo) => todo.id === 'old')?.archivedAt, 'number')
  // Told once.
  await handle.look()
  assert.equal(host.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the settings can turn reminders and archiving off', async () => {
  const now = Date.now()
  const list = [
    { id: 'due', text: 'Pay', done: false, createdAt: 1, due: '2000-01-01' },
    { id: 'old', text: 'Old', done: true, createdAt: 1, doneAt: now - 30 * 86_400_000 }
  ]
  const host = mockHost({ storage: { todos: list as never }, settings: { dueReminders: false, archiveAfterDays: 0 } })
  const handle = createWorker(cli, quiet)
  const worker = await mountWorker(handle, { host })
  await handle.look()
  assert.deepEqual(host.callsOf('notifications.show'), [])
  assert.equal((host.data().storage.todos as unknown as { archivedAt?: number }[])[1].archivedAt, undefined)
  await worker.deactivate()
})

test('lists an idle agent that the terminal list no longer names', async () => {
  const idle: OrcaCli = async (args) => {
    if (args[0] === 'terminal') {
      return {
        terminals: [
          { handle: 'term_busy', title: 'Diagram', agentIdentity: 'claude', worktreeId: 'w1', tabId: 'tab1', leafId: 'a' },
          { handle: 'term_idle', title: 'Pull latest changes', agentIdentity: null, worktreeId: 'w2', tabId: 'tab2', leafId: 'b' },
          { handle: 'term_shell', title: 'Diagram', agentIdentity: null, worktreeId: 'w1', tabId: 'tab1', leafId: 'c' }
        ]
      }
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return { worktrees: [{ agents: [{ paneKey: 'tab1:a', agentType: 'claude', state: 'working' }, { paneKey: 'tab2:b', agentType: 'claude', state: 'done' }] }] }
    }
    return { environments: [] }
  }
  const worker = await mountWorker(createWorker(idle, quiet), { host: mockHost() })
  const listed = await worker.request('agents.list')
  assert.ok(listed.ok)
  // The idle agent is found through the pane report; the plain shell beside it is not an agent.
  assert.deepEqual(listed.agents.map((agent) => [agent.terminalId, agent.agent]), [
    ['term_busy', 'claude'],
    ['term_idle', 'claude']
  ])
  await worker.deactivate()
})
