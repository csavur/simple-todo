// The one file the worker reads and writes outside the plugin: the inbox agents append to-dos to.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Reading and emptying the inbox, so tests can stand in for the disk. */
export interface InboxFile {
  path: string
  /** The file's text; empty when there is no file. */
  read(): Promise<string>
  /** Leaves the file empty. */
  clear(): Promise<void>
}

export function inboxFile(): InboxFile {
  const path = join(homedir(), '.simple-todo', 'inbox.md')
  return {
    path,
    async read() {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return ''
      }
    },
    async clear() {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '', 'utf8')
    }
  }
}
