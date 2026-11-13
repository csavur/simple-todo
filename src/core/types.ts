// The data model, shared by the panel and the worker.

/** Most pressing first. `none` is a task without a flag. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const
export type Priority = (typeof PRIORITIES)[number]

/** What an agent a task was sent to is doing. `gone` means its terminal no longer exists. */
export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done', 'gone'] as const
export type AgentState = (typeof AGENT_STATES)[number]

/** The agent a task was sent to, so its progress can be shown on the task. */
export interface AgentLink {
  terminalId: string
  /** The paired Orca server that owns the terminal; absent for this Orca. */
  environmentId?: string
  /** What to call the agent: its terminal's title, or its kind for a new one. */
  title: string
  sentAt: number
  /** Unknown until the worker has looked. */
  state?: AgentState
  /** Whether the agent has been seen working since the task was sent. An agent that was idle
   *  when it got the task reads as `done` at first, which must not count as finishing it. */
  started?: boolean
}

export interface Todo {
  id: string
  /** Markdown. */
  text: string
  done: boolean
  createdAt: number
  /** The project this task is tagged with: an Orca project's name, or any name typed by hand. */
  project?: string
  /** Absent means `none`. */
  priority?: Priority
  /** Free labels, without the `#`. */
  tags?: string[]
  /** The day it is due, as `YYYY-MM-DD` in local time. */
  due?: string
  /** When it was marked done. */
  doneAt?: number
  /** When it was archived: out of the lists, still searchable under "Archived". */
  archivedAt?: number
  /** The list it belongs to; absent means the first list (`DEFAULT_LIST`). */
  list?: string
  agent?: AgentLink
  /** Set on a task an agent added through the inbox file. */
  origin?: 'agent'
}

/** The id of the list every installation starts with. */
export const DEFAULT_LIST = 'default'

/** The storage keys both sides read. */
export const TODOS_KEY = 'todos'
export const PREFS_KEY = 'prefs'
