import { assert, test } from 'orca/testing'
import { applySlash, matchSlash, SLASH_COMMANDS, slashQuery, type SlashCommand } from './slash.ts'

const command = (id: string) => SLASH_COMMANDS.find((c) => c.id === id) as SlashCommand

/** Types `typed` (ending in a "/query") into `before|after` and picks a command. */
function pick(before: string, after: string, id: string) {
  const slash = slashQuery(before + after, before.length)
  assert.ok(slash, `no slash query in ${JSON.stringify(before)}`)
  const result = applySlash(before + after, slash, before.length, command(id))
  return `${result.text.slice(0, result.selectionStart)}[${result.text.slice(result.selectionStart, result.selectionEnd)}]${result.text.slice(result.selectionEnd)}`
}

test('finds the slash token at the caret', () => {
  assert.deepEqual(slashQuery('/', 1), { start: 0, query: '' })
  assert.deepEqual(slashQuery('Fix it\n/he', 10), { start: 7, query: 'he' })
  assert.deepEqual(slashQuery('- item /bo', 10), { start: 7, query: 'bo' })
  // The caret decides: text after it is not part of the query.
  assert.deepEqual(slashQuery('/head tail', 3), { start: 0, query: 'he' })
})

test('does not read paths, dates or finished words as a slash token', () => {
  assert.equal(slashQuery('a/b', 3), null)
  assert.equal(slashQuery('1/2', 3), null)
  assert.equal(slashQuery('see /usr/bin', 12), null)
  assert.equal(slashQuery('/head done', 10), null)
  assert.equal(slashQuery('/a\nnext', 7), null)
  assert.equal(slashQuery('no slash', 4), null)
})

test('matches commands by name and keyword, best first', () => {
  assert.equal(matchSlash('').length, SLASH_COMMANDS.length)
  // A name that starts with the query comes before one that only contains it ("checkbox").
  assert.deepEqual(matchSlash('he').map((c) => c.id), ['heading', 'todo'])
  assert.deepEqual(matchSlash('list').map((c) => c.id), ['bullet', 'number', 'todo'])
  assert.deepEqual(matchSlash('task').map((c) => c.id), ['todo'])
  assert.deepEqual(matchSlash('CODE').map((c) => c.id), ['codeblock', 'code'])
  assert.deepEqual(matchSlash('zzz'), [])
})

test('a block command sets the kind of the line', () => {
  assert.equal(pick('/he', '', 'heading'), '# []')
  assert.equal(pick('Title\n/', '', 'todo'), 'Title\n- [ ] []')
  assert.equal(pick('Release notes /h', '', 'heading'), '# Release notes []')
  assert.equal(pick('  /bul', '', 'bullet'), '  - []')
  // A marker the line already has is replaced, not stacked.
  assert.equal(pick('- buy milk /todo', '', 'todo'), '- [ ] buy milk []')
  assert.equal(pick('# old /q', '\nnext', 'quote'), '> old []\nnext')
  assert.equal(pick('1. first /bullet', '', 'bullet'), '- first []')
})

test('an inline command wraps a sample, selected to type over', () => {
  assert.equal(pick('Make it /b', '', 'bold'), 'Make it **[bold]**')
  assert.equal(pick('See /link', ' now', 'link'), 'See [[text]](https://) now')
  assert.equal(pick('/code', '', 'code'), '`[code]`')
})

test('a code block stands on its own lines', () => {
  assert.equal(pick('/code', '', 'codeblock'), '```\n[]\n```')
  assert.equal(pick('Run this /code', '', 'codeblock'), 'Run this \n```\n[]\n```')
  assert.equal(pick('/code', 'after', 'codeblock'), '```\n[]\n```\nafter')
})
