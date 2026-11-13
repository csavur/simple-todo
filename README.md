# Simple Todo

A to-do list in [Orca](https://www.onorca.dev)'s right sidebar: Markdown to-dos with priorities, due days, tags and lists, that you can hand to an agent and follow.

![The Simple Todo panel](assets/cover.png)

## Install

In Orca, open Settings → Plugins and search for `simple-todo`, or run:

```sh
orca plugin install csavur/simple-todo
```

Orca lists the access the plugin asks for (see [Access](#access)) and installs it once you approve.

## Features

- **Markdown to-dos**: a multi-line editor with a preview. Type `/` for a menu of headings, lists, checklists, quotes, code and emphasis. Enter continues a list. Tick boxes in a to-do can be ticked right in the list, and the card shows how many are done.
- **Priorities and due days**: Urgent, High, Medium, Low, and an optional due day shown as "Today", "Tomorrow" or "2d overdue". A desktop notification says when a to-do becomes due.
- **Projects and tags**: tag a to-do with one of your Orca projects (paired Orca servers included) or any name you type, and with free tags such as `#bug`.
- **Lists**: several named lists; the list's name at the top opens the menu to switch, add, rename and delete them.
- **Find and order**: a status dropdown (open, done, all, archived), a search box, a filter menu for projects, priorities, tags and due days, and sorting by priority, due day or age. Drag a to-do by its handle to keep your own order.
- **Send to an agent**: hand a to-do to an agent already running in a terminal, in any workspace or on a paired server, or start a new agent with it. The card then shows what that agent is doing, and can mark the to-do done when the agent finishes.
- **From an agent**: agents can add to-dos by appending a line to `~/.simple-todo/inbox.md`. "Copy instructions for agents" in the list menu gives the text to paste to one.
- **Housekeeping**: undo after deleting, clearing, archiving and importing; done to-dos are archived after a number of days; export a list as Markdown or everything as a JSON backup, and import either.
- **Quick add and status bar**: Cmd+Alt+/ opens the form for a new to-do. The status bar shows how many are open, flagged when any is urgent or overdue.

Tasks are stored on this machine only, in the plugin's own storage.

## Access

The plugin runs a worker (`trusted-worker`), which Orca keeps running to update the status bar.

| Capability | Used for |
|---|---|
| `storage:own` | The task list |
| `workspace:read` | Listing your Orca projects and their workspaces |
| `workspace:write` | Opening a workspace when you press a task's project |
| `agent:read` | Listing the agents running in the focused workspace |
| `agent:launch` | Starting a new agent with a task |
| `terminal:send` | Sending a task to a running agent |
| `notifications:show` | Reminding you when a to-do is due |
| `settings:own` | The options under the plugin in Orca's Settings |

Projects on a paired Orca server belong to another Orca runtime, which the plugin API does not reach. For those the worker runs the `orca` CLI that ships with the app (`environment list`, `repo list`, `worktree list`, `worktree ps`, `terminal list`, `terminal send`, `worktree activate`, `agent launch` and `plugin open`). The CLI acts with your own access, outside the capability list above.

## Develop

There is no build step: Orca loads the TypeScript as written.

```sh
orca plugin dev reload .          # load the folder's current files into Orca
orca plugin test .                # unit tests for the rules, markup, worker and helpers
```

Keep generated files out of this folder: Orca checks the folder's contents before it starts the
worker, and a `.orca/` folder (typings, screenshots) left here fails that check. Remove it after a
reload, and save screenshots elsewhere with `orca plugin shot <key> --out <file>`.

The panel draws its own HTML (`panel/index.html`, `panel/panel.css`) on Orca's theme variables, so
it can have popovers and menus that Orca's component kit lacks. Its markup is built by pure
functions (`src/ui/view.ts`) from a plain state object (`src/ui/state.ts`), which is what the tests
check; `src/ui/main.ts` is the only part that touches the DOM and Orca.

## Licence

MIT, see [LICENSE](LICENSE). The bundled font, `panel/fonts/Geist-Variable.woff2`, is Geist by Vercel under the SIL Open Font License 1.1, see [panel/fonts/OFL.txt](panel/fonts/OFL.txt).

## Layout

```
assets/            the plugin's icon and cover image
panel/             the page, its stylesheet and font
src/
├── core/          shared by the panel and the worker: data model, list functions, Markdown
├── ui/            the panel: state rules, markup, and the script that wires them to Orca
├── worker/        the `orca` CLI runner, paired-server projects, running agents, and the timed chores
├── protocol.ts    the requests the panel makes of the worker
└── worker.ts      status bar, palette command, workspaces and agents
```
