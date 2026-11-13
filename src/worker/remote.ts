// Projects on paired Orca servers. Each paired server is its own Orca runtime with its own
// repositories and worktrees, which `workspace.list` does not cover, so they are read through
// the CLI (`--environment`).
import type { OrcaProject, OrcaWorkspace } from '../protocol.ts'
import type { OrcaCli } from './cli.ts'

interface Environment {
  id: string
  name: string
}

function records(value: unknown, key: string): Record<string, unknown>[] {
  const list = (value as Record<string, unknown> | null)?.[key]
  return Array.isArray(list)
    ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** `refs/heads/fix-login` as `fix-login`. */
function branchName(ref: unknown): string | null {
  return text(ref)?.replace(/^refs\/heads\//, '') ?? null
}

export async function listEnvironments(cli: OrcaCli): Promise<Environment[]> {
  const environments: Environment[] = []
  for (const item of records(await cli(['environment', 'list']), 'environments')) {
    const id = text(item.id)
    if (id) {
      environments.push({ id, name: text(item.name) ?? id })
    }
  }
  return environments
}

/** One paired server's repositories as projects, each with its worktrees. */
export async function listEnvironmentProjects(
  cli: OrcaCli,
  environment: Environment
): Promise<OrcaProject[]> {
  const flag = `--environment=${environment.id}`
  const [repos, worktrees] = await Promise.all([
    cli(['repo', 'list', flag]),
    cli(['worktree', 'list', flag])
  ])
  const projects = new Map<string, OrcaProject>()
  for (const repo of records(repos, 'repos')) {
    const id = text(repo.id)
    const name = text(repo.displayName)
    if (id && name) {
      projects.set(id, { name, workspaces: [] })
    }
  }
  for (const worktree of records(worktrees, 'worktrees')) {
    const id = text(worktree.id)
    const project = projects.get(text(worktree.repoId) ?? '')
    if (!id || !project || worktree.isArchived === true) {
      continue
    }
    const workspace: OrcaWorkspace = {
      id,
      kind: 'worktree',
      name: text(worktree.displayName) ?? id,
      branch: branchName(worktree.branch),
      environment
    }
    // The repository's own checkout first, as Orca's sidebar lists it.
    if (worktree.isMainWorktree === true) {
      project.workspaces.unshift(workspace)
    } else {
      project.workspaces.push(workspace)
    }
  }
  return [...projects.values()].filter((project) => project.workspaces.length > 0)
}

/**
 * The projects of every paired server. A server that cannot be reached (asleep, tunnel down) is
 * skipped and reported to `log`, so the others and the local projects still show.
 */
export async function listRemoteProjects(
  cli: OrcaCli,
  log: (message: string) => void
): Promise<OrcaProject[]> {
  let environments: Environment[]
  try {
    environments = await listEnvironments(cli)
  } catch (error) {
    log(`could not list paired Orca servers: ${error instanceof Error ? error.message : error}`)
    return []
  }
  const perEnvironment = await Promise.all(
    environments.map((environment) =>
      listEnvironmentProjects(cli, environment).catch((error: unknown) => {
        log(
          `could not list projects on ${environment.name}: ${error instanceof Error ? error.message : error}`
        )
        return [] as OrcaProject[]
      })
    )
  )
  return perEnvironment.flat()
}

/** Projects with the same name, here and on a server, are one project with all their workspaces. */
export function mergeProjects(...lists: readonly OrcaProject[][]): OrcaProject[] {
  const merged = new Map<string, OrcaProject>()
  for (const project of lists.flat()) {
    const existing = merged.get(project.name)
    if (existing) {
      existing.workspaces.push(...project.workspaces)
    } else {
      merged.set(project.name, { name: project.name, workspaces: [...project.workspaces] })
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
