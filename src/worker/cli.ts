// Runs the `orca` CLI from the worker. The plugin host API only reaches the Orca this plugin
// runs in; a paired Orca server is another runtime, and the CLI is the one way to it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Runs `orca <args> --json` and resolves with its `result`, or rejects with its error message. */
export type OrcaCli = (args: readonly string[]) => Promise<unknown>

/** The CLI that ships inside the Orca app running this worker; `orca` on the PATH otherwise. */
export function orcaCliPath(): string {
  const candidates: string[] = []
  const resources = process.resourcesPath
  if (resources) {
    candidates.push(join(resources, 'bin', 'orca'))
  }
  const app = /^(.*?\.app)\//.exec(process.execPath)?.[1]
  if (app) {
    candidates.push(join(app, 'Contents', 'Resources', 'bin', 'orca'))
  }
  return candidates.find((path) => existsSync(path)) ?? 'orca'
}

/** What the CLI printed, as its result. The CLI answers `{ ok, result }` or `{ ok, error }`. */
export function parseCliOutput(stdout: string): unknown {
  let answer: { ok?: unknown; result?: unknown; error?: { message?: unknown } }
  try {
    answer = JSON.parse(stdout)
  } catch {
    throw new Error('The orca CLI did not answer with JSON.')
  }
  if (answer?.ok !== true) {
    const message = answer?.error?.message
    throw new Error(typeof message === 'string' ? message : 'The orca CLI reported a failure.')
  }
  return answer.result
}

export const runOrcaCli: OrcaCli = (args) =>
  new Promise((resolve, reject) => {
    // No shell: every argument reaches the CLI as written, whatever a task's text holds.
    execFile(
      orcaCliPath(),
      [...args, '--json'],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        try {
          // A failing command still prints its JSON error; prefer that to the exit status.
          resolve(parseCliOutput(stdout))
        } catch (parseError) {
          reject(stdout.trim() ? parseError : (error ?? parseError))
        }
      }
    )
  })
