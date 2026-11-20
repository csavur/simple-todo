import { assert, test } from 'orca/testing'
import { join } from 'node:path'
import { cliEnv, parseCliOutput } from './cli.ts'

test('parseCliOutput returns the result of a successful command', () => {
  assert.deepEqual(parseCliOutput('{"ok":true,"result":{"repos":[]}}'), { repos: [] })
})

test('parseCliOutput throws the CLI error message', () => {
  assert.throws(
    () => parseCliOutput('{"ok":false,"error":{"code":"x","message":"no such worktree"}}'),
    /no such worktree/
  )
  assert.throws(() => parseCliOutput('{"ok":false}'), /reported a failure/)
  assert.throws(() => parseCliOutput('not json'), /did not answer with JSON/)
})

test('on Windows the CLI gets APPDATA back when the worker has none', () => {
  const home = join('C:', 'Users', 'me')
  assert.deepEqual(cliEnv({ PATH: 'x' }, 'win32', home), {
    PATH: 'x',
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local')
  })
  assert.equal(cliEnv({ APPDATA: 'D:/roam' }, 'win32', home).APPDATA, 'D:/roam')
  assert.deepEqual(cliEnv({ PATH: 'x' }, 'darwin', home), { PATH: 'x' })
})
