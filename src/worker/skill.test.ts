// Against a real folder standing in for the home folder: links and renames are the point.
import { mkdir, mkdtemp, readFile, readlink, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { inboxFileAt } from './files.ts'
import { syncSkill } from './skill.ts'

const newHome = (): Promise<string> => mkdtemp(join(tmpdir(), 'simple-todo-'))
const skillFile = (home: string): string => join(home, '.agents', 'skills', 'simple-todo', 'SKILL.md')
const claudeLink = (home: string): string => join(home, '.claude', 'skills', 'simple-todo')

async function there(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

test('installs the skill, links it for an agent with its own skills folder, and updates it', async () => {
  const home = await newHome()
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  const first = await syncSkill(home, 'one', true, null)
  assert.deepEqual(first, { written: 'one', notes: [] })
  assert.equal(await readFile(skillFile(home), 'utf8'), 'one')
  assert.equal(await readlink(claudeLink(home)), '../../.agents/skills/simple-todo')
  // Through the link, as the agent reads it.
  assert.equal(await readFile(join(claudeLink(home), 'SKILL.md'), 'utf8'), 'one')
  // A newer plugin brings a newer text.
  assert.deepEqual(await syncSkill(home, 'two', true, 'one'), { written: 'two', notes: [] })
  assert.equal(await readFile(skillFile(home), 'utf8'), 'two')
  // In step: nothing to do.
  assert.deepEqual(await syncSkill(home, 'two', true, 'two'), { written: 'two', notes: [] })
})

test('without an agent skills folder there is no link', async () => {
  const home = await newHome()
  assert.deepEqual(await syncSkill(home, 'one', true, null), { written: 'one', notes: [] })
  assert.equal(await there(join(home, '.claude')), false)
})

test('turned off, removes the skill and its link', async () => {
  const home = await newHome()
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await syncSkill(home, 'one', true, null)
  assert.deepEqual(await syncSkill(home, 'one', false, 'one'), { written: null, notes: [] })
  assert.equal(await there(join(home, '.agents', 'skills', 'simple-todo')), false)
  assert.equal(await there(claudeLink(home)), false)
  assert.equal(await there(join(home, '.claude', 'skills')), true)
  // Off and nothing there: nothing happens.
  assert.deepEqual(await syncSkill(home, 'one', false, null), { written: null, notes: [] })
})

test('a skill the person installed or changed is never written over or removed', async () => {
  const home = await newHome()
  await mkdir(join(home, '.agents', 'skills', 'simple-todo'), { recursive: true })
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await writeFile(skillFile(home), 'mine', 'utf8')
  // Theirs from the start.
  const kept = await syncSkill(home, 'one', true, null)
  assert.equal(kept.written, null)
  assert.match(kept.notes[0], /left .* alone/)
  // Ours once, then changed by them.
  assert.equal((await syncSkill(home, 'two', true, 'one')).written, null)
  assert.deepEqual(await syncSkill(home, 'two', false, 'one'), { written: null, notes: [] })
  assert.equal(await readFile(skillFile(home), 'utf8'), 'mine')
  assert.equal(await there(claudeLink(home)), false)
  // The same text, put there another way, is still theirs.
  await writeFile(skillFile(home), 'two', 'utf8')
  assert.deepEqual(await syncSkill(home, 'two', true, null), { written: null, notes: [] })
  assert.deepEqual(await syncSkill(home, 'two', false, null), { written: null, notes: [] })
  assert.equal(await readFile(skillFile(home), 'utf8'), 'two')
})

test('a skill of that name already in the agent folder is left as it is', async () => {
  const home = await newHome()
  await mkdir(claudeLink(home), { recursive: true })
  await writeFile(join(claudeLink(home), 'SKILL.md'), 'mine', 'utf8')
  assert.deepEqual(await syncSkill(home, 'one', true, null), { written: 'one', notes: [] })
  assert.equal(await readFile(join(claudeLink(home), 'SKILL.md'), 'utf8'), 'mine')
  await syncSkill(home, 'one', false, 'one')
  assert.equal(await readFile(join(claudeLink(home), 'SKILL.md'), 'utf8'), 'mine')
})

test('an agent folder that cannot be linked into is reported, and the skill still installed', async () => {
  const home = await newHome()
  // A file where the folder should be: making a link inside it fails.
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude', 'skills'), '', 'utf8')
  const { written, notes } = await syncSkill(home, 'one', true, null)
  assert.equal(written, 'one')
  assert.match(notes[0], /could not link the agent skill/)
})

test('the inbox is taken whole, and what is appended after starts a new one', async () => {
  const home = await newHome()
  const path = join(home, 'inbox.md')
  const inbox = inboxFileAt(path)
  assert.equal(await inbox.take(), '')
  await writeFile(path, '- one\n', 'utf8')
  assert.equal(await inbox.take(), '- one\n')
  assert.equal(await there(path), false)
  assert.equal(await inbox.take(), '')
  // What a worker that stopped mid-take left aside is not lost.
  await writeFile(`${path}.taken`, '- left', 'utf8')
  await writeFile(path, '- new\n', 'utf8')
  assert.equal(await inbox.take(), '- left\n- new\n')
  assert.equal(await there(`${path}.taken`), false)
})
