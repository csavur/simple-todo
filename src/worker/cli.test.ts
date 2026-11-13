import { assert, test } from 'orca/testing'
import { parseCliOutput } from './cli.ts'

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
