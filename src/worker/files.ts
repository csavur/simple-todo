// The one file the worker reads outside the plugin: the inbox agents append to-dos to.
import { readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Taking what the inbox holds, so tests can stand in for the disk. */
export interface InboxFile {
  path: string
  /** The file's text, which is no longer in the inbox after; empty when there is nothing. */
  take(): Promise<string>
}

async function readIfThere(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The inbox at `path`. Taking moves the file aside before reading it, so a line an agent appends
 * meanwhile starts a new inbox for the next look instead of being wiped with what was just read.
 */
export function inboxFileAt(path: string): InboxFile {
  const taken = `${path}.taken`
  /** Reads and removes what was moved aside. */
  async function drain(): Promise<string> {
    const text = await readIfThere(taken)
    await rm(taken, { force: true })
    return text
  }
  return {
    path,
    async take() {
      // What a worker that stopped mid-take left behind comes first.
      const left = await drain()
      try {
        await rename(path, taken)
      } catch {
        // No inbox: nothing was appended since the last look.
        return left
      }
      const text = await drain()
      return left && text ? `${left.replace(/\n?$/, '\n')}${text}` : left || text
    }
  }
}

export function inboxFile(): InboxFile {
  return inboxFileAt(join(homedir(), '.simple-todo', 'inbox.md'))
}
