// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Only the worker may list and open workspaces, launch agents and type into terminals, so the
// panel asks it to. The task list itself is not part of the contract: both sides read it from
// the plugin's storage (see core/types.ts).

export interface OrcaWorkspace {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  branch: string | null
  /** The paired Orca server that owns it; absent for a workspace of this Orca. */
  environment?: { id: string; name: string }
}

/** Names a workspace to the worker: its id, and its paired server when it has one. */
export interface WorkspaceRef {
  workspaceId: string
  environmentId?: string
}

/** An Orca project: one repository with all its worktrees, or one folder. */
export interface OrcaProject {
  name: string
  workspaces: OrcaWorkspace[]
}

/** An agent running in a terminal, here or on a paired Orca server. */
export interface AgentOption {
  terminalId: string
  /** The terminal's title, which Orca sets to what the agent is working on. */
  title: string
  /** The agent's kind, such as `claude`. */
  agent: string
  /** The workspace it runs in, when Orca names one. */
  workspaceId: string | null
  /** The paired Orca server that owns it; absent for an agent of this Orca. */
  environment?: { id: string; name: string }
}

/** A request either worked or failed with a message fit to show the person. */
export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string }

declare module 'orca' {
  interface PluginRequests {
    /** Every Orca project, here and on paired Orca servers, sorted by name. */
    'projects.list': { output: Outcome<{ projects: OrcaProject[] }> }
    /** Shows a workspace in Orca, as clicking it in the sidebar does. */
    'workspace.open': { input: WorkspaceRef; output: Outcome }
    /** Every agent running in a terminal, here and on paired Orca servers. */
    'agents.list': { output: Outcome<{ agents: AgentOption[] }> }
    /** Submits a prompt to an agent that is already running. */
    'agent.send': {
      input: { terminalId: string; environmentId?: string; prompt: string }
      output: Outcome
    }
    /** Starts a new agent in a workspace with a prompt; answers its terminal when Orca names one. */
    'agent.launch': {
      input: WorkspaceRef & { agent: string; prompt: string }
      output: Outcome<{ terminalId?: string }>
    }
    /** The file agents append to-dos to. */
    'inbox.path': { output: { path: string } }
    /** Whether the quick-add shortcut was pressed while no panel was open to hear it. Asking clears it. */
    'compose.take': { output: { pending: boolean } }
  }
  interface PluginPanelEvents {
    /** The quick-add shortcut was pressed: open the form for a new to-do. */
    compose: Record<string, never>
  }
}
