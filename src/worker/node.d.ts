// The few Node APIs the worker uses. A plugin folder cannot hold node_modules, so
// @types/node is not available here; these declarations cover exactly what is called.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
}

declare module 'node:fs/promises' {
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  export function mkdir(path: string, options: { recursive: true }): Promise<unknown>
  export function mkdtemp(prefix: string): Promise<string>
  export function rename(from: string, to: string): Promise<void>
  /** With `force`, a path that is not there is not an error. */
  export function rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>
  /** Removes an empty folder; fails on one that holds anything. */
  export function rmdir(path: string): Promise<void>
  /** The path itself, not what a link at it points to. */
  export function lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  export function readlink(path: string): Promise<string>
  export function symlink(target: string, path: string, type: 'dir'): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare const process: { execPath: string; resourcesPath?: string; pid: number }
