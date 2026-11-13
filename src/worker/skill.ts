// Installs the agent skill (src/core/skill.ts) where coding agents look for skills, the way
// `orca skills install` lays its own out: the skill in the shared `~/.agents/skills` folder, and
// a link to it in the skills folder of each agent that has one of its own.
//
// These folders are the person's, so the worker only ever touches a copy it wrote and nobody
// changed since. A skill of the same name that came another way (their dotfiles, a skills
// manager) or that they edited is left exactly as it is.
import { lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SKILL_NAME } from '../core/skill.ts'

/** Agents that read skills from a folder of their own instead of the shared one, under home. */
const AGENT_SKILL_FOLDERS = [['.claude', 'skills']] as const
const LINK_TARGET = `../../.agents/skills/${SKILL_NAME}`

export interface SkillSync {
  /** The text of the copy the worker wrote and still looks after; null when it has none. */
  written: string | null
  /** What could not be done or was left alone, fit for the log. */
  notes: string[]
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether anything sits at `path`, a link that points nowhere included. */
async function occupied(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Whether `path` is the link this module makes. */
async function isOurLink(path: string): Promise<boolean> {
  try {
    return (await readlink(path)) === LINK_TARGET
  } catch {
    return false
  }
}

/**
 * Brings the installed skill in line with `enabled`: writes or updates it, or removes it.
 * `written` is what the last call answered, kept by the caller between runs.
 */
export async function syncSkill(home: string, text: string, enabled: boolean, written: string | null): Promise<SkillSync> {
  const folder = join(home, '.agents', 'skills', SKILL_NAME)
  const file = join(folder, 'SKILL.md')
  const links = AGENT_SKILL_FOLDERS.map((parts) => ({ skills: join(home, ...parts), link: join(home, ...parts, SKILL_NAME) }))
  const notes: string[] = []
  const found = await readIfThere(file)
  const ours = found !== null && found === written

  if (!enabled) {
    if (!ours) {
      // Nothing of ours is there; a copy someone changed is theirs now.
      return { written: null, notes }
    }
    try {
      for (const { link } of links) {
        if (await isOurLink(link)) {
          await rm(link, { force: true })
        }
      }
      await rm(file, { force: true })
      // Only when nothing else was put in it.
      await rmdir(folder).catch(() => undefined)
      return { written: null, notes }
    } catch (error) {
      return { written, notes: [`could not remove the agent skill: ${messageOf(error)}`] }
    }
  }

  let next = written
  if (found === null || (ours && found !== text)) {
    try {
      await mkdir(folder, { recursive: true })
      // Written whole or not at all: an agent never reads half a skill.
      const draft = `${file}.${process.pid}.tmp`
      await writeFile(draft, text, 'utf8')
      await rename(draft, file)
      next = text
    } catch (error) {
      return { written, notes: [`could not write the agent skill to ${file}: ${messageOf(error)}`] }
    }
  } else if (!ours && found !== text) {
    notes.push(`left ${file} alone: it was not written by Simple Todo, or was changed since`)
    return { written: null, notes }
  } else if (!ours) {
    // The same text, put there another way: nothing to do, and not ours to link or remove.
    return { written: null, notes }
  }

  for (const { skills, link } of links) {
    // An agent without a skills folder is not installed, or keeps its skills elsewhere.
    if (!(await occupied(skills)) || (await occupied(link))) {
      continue
    }
    try {
      await symlink(LINK_TARGET, link, 'dir')
    } catch (error) {
      notes.push(`could not link the agent skill into ${dirname(link)}: ${messageOf(error)}`)
    }
  }
  return { written: next, notes }
}
