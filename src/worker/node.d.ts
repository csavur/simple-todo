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
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  export function mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare const process: { execPath: string; resourcesPath?: string }
