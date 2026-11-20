// The vault folder on disk: the Markdown notes directly in it. What to write is worked out in
// src/core/vault.ts; this only reads, writes and removes the notes it is told to.
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultFile } from '../core/vault.ts'

export interface VaultDisk {
  folder: string
  /** Whether the folder is there. A vault that is not (an unplugged drive) is not synced at all. */
  exists(): Promise<boolean>
  /** Every `.md` note directly in the folder. */
  read(): Promise<VaultFile[]>
  write(file: VaultFile): Promise<void>
  remove(name: string): Promise<void>
}

export function vaultDiskAt(folder: string): VaultDisk {
  return {
    folder,
    async exists() {
      try {
        return (await stat(folder)).isDirectory()
      } catch {
        return false
      }
    },
    async read() {
      const entries = await readdir(folder, { withFileTypes: true })
      const notes = entries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      const files: VaultFile[] = []
      for (const entry of notes) {
        try {
          files.push({ name: entry.name, text: await readFile(join(folder, entry.name), 'utf8') })
        } catch {
          // Gone between listing and reading: it is not there.
        }
      }
      return files
    },
    async write({ name, text }) {
      await writeFile(join(folder, name), text, 'utf8')
    },
    async remove(name) {
      await rm(join(folder, name), { force: true })
    }
  }
}
