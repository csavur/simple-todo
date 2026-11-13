// The agent skill that tells a coding agent how to add a to-do. The same text reaches agents two
// ways: `skills/simple-todo/SKILL.md` in this repository, for people who manage their agents'
// skills themselves, and the copy the worker installs (src/worker/skill.ts). A test keeps the
// file in step with this function.

export const SKILL_NAME = 'simple-todo'

/** The inbox as a skill names it: the same file for everyone, whatever their home folder is. */
export const SKILL_INBOX = '~/.simple-todo/inbox.md'

export function skillText(): string {
  return `---
name: ${SKILL_NAME}
description: Add a to-do to the user's Simple Todo list in Orca. Use when the user asks to add, note or remember a to-do or task for later, or when you finish and leave follow-up work undone that the user should not lose.
---

# Simple Todo

Simple Todo is the user's to-do list in Orca's sidebar. You add to it by appending lines to a
file. Orca takes them in within a few seconds, or when it next starts, and empties the file.

## Add a to-do

Append one line per to-do to \`${SKILL_INBOX}\`. Create the folder and the file if they are
missing. Each line is a Markdown list item:

\`\`\`
- [ ] Text of the to-do !high @project-name #tag due:2026-01-31
\`\`\`

From a shell:

\`\`\`sh
mkdir -p ~/.simple-todo
cat >> ~/.simple-todo/inbox.md <<'TODO'
- [ ] Text of the to-do !high @project-name #tag
TODO
\`\`\`

The markers are optional, and go anywhere in the line as words of their own:

- \`!urgent\`, \`!high\`, \`!medium\` or \`!low\`: the priority.
- \`@name\`: the project. Use the name Orca shows for it, which is usually the name of the
  repository's folder. It has no spaces.
- \`#name\`: a tag. Repeat it for several.
- \`due:YYYY-MM-DD\`, \`due:today\` or \`due:tomorrow\`: the due day.

## Rules

- Append only (\`>>\`, never \`>\`). Do not edit or remove lines that are already in the file:
  they are to-dos Orca has not taken in yet.
- One line per to-do. Write it so the user can act on it without this conversation: say what
  and where, not "fix the thing we discussed".
- Tag it with the project you are working in, unless the to-do is about something else.
- You can only add. You cannot list, tick or delete to-dos; when asked to, say so.
- Tell the user which to-dos you added.
`
}
