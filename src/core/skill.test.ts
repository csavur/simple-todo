import { readFile } from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import { parseChecklist } from './transfer.ts'
import { SKILL_INBOX, SKILL_NAME, skillText } from './skill.ts'

test('the skill file in the repository is the text the worker installs', async () => {
  const file = new URL(`../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url)
  assert.equal(await readFile(file, 'utf8'), skillText())
})

test('the skill names itself, the inbox and a line the inbox reads', () => {
  const text = skillText()
  assert.match(text, /^---\nname: simple-todo\ndescription: .+\n---\n/)
  assert.ok(text.includes(SKILL_INBOX))
  const example = /^- \[ \] .*due:.*$/m.exec(text)?.[0] ?? ''
  assert.deepEqual(parseChecklist(example, '2026-01-01'), [
    { text: 'Text of the to-do', project: 'project-name', priority: 'high', tags: ['tag'], due: '2026-01-31', done: false }
  ])
})
