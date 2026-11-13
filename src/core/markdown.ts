// Typing help for Markdown in a Textarea. Orca's Textarea reports only the whole new text, never
// the caret or the key, so each helper works out what was typed by comparing the old text with
// the new one, and acts only when exactly one character was inserted.

/** Where a single character was inserted to turn `previous` into `next`, or null if that is not what happened. */
function insertionOf(previous: string, next: string): { index: number; char: string } | null {
  if (next.length !== previous.length + 1) {
    return null
  }
  let index = 0
  while (index < previous.length && previous[index] === next[index]) {
    index++
  }
  return next.slice(index + 1) === previous.slice(index) ? { index, char: next[index] } : null
}

// indent, bullet or number with its delimiter, spacing, optional task box, the rest of the line.
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/

/**
 * Enter at the end of a list item starts the next item with the same marker (numbers count up,
 * task boxes start unticked). Enter on an item that has only its marker ends the list instead.
 */
export function continueList(previous: string, next: string): string {
  const inserted = insertionOf(previous, next)
  if (!inserted || inserted.char !== '\n') {
    return next
  }
  // A line break typed at the end of a line gives the same text as one typed at the start of
  // the next line. Read it as the end of the line: that is where a list is continued.
  const index =
    inserted.index > 0 && previous[inserted.index - 1] === '\n' ? inserted.index - 1 : inserted.index
  const lineEnd = previous.indexOf('\n', index)
  const afterCaret = previous.slice(index, lineEnd === -1 ? previous.length : lineEnd)
  // Only at the end of a line: splitting an item in two should stay a plain line break.
  if (afterCaret.trim()) {
    return next
  }
  const lineStart = previous.lastIndexOf('\n', index - 1) + 1
  const match = LIST_ITEM.exec(previous.slice(lineStart, index))
  if (!match) {
    return next
  }
  const [, indent, bullet, number, delimiter, spacing, taskBox, rest] = match
  if (!rest.trim()) {
    return previous.slice(0, lineStart) + previous.slice(index)
  }
  const marker = bullet ?? `${Number(number) + 1}${delimiter}`
  const prefix = `${indent}${marker}${spacing}${taskBox ? '[ ] ' : ''}`
  return next.slice(0, index + 1) + prefix + next.slice(index + 1)
}

const TASK_BOX_START = /^\s*(?:[-*+]|\d+[.)])\s+\[$/

/** Typing `[` right after a list marker completes it to an unticked task box: `- [` becomes `- [ ] `. */
export function completeTaskBox(previous: string, next: string): string {
  const inserted = insertionOf(previous, next)
  if (!inserted || inserted.char !== '[') {
    return next
  }
  const { index } = inserted
  const lineStart = next.lastIndexOf('\n', index) + 1
  if (!TASK_BOX_START.test(next.slice(lineStart, index + 1))) {
    return next
  }
  const after = previous.slice(index)
  // Already a box: leave it alone.
  if (/^ ?\]/.test(after)) {
    return next
  }
  return `${next.slice(0, index)}[ ] ${after.replace(/^[ \t]+/, '')}`
}

/** Every helper, applied to one edit. */
export function assistMarkdown(previous: string, next: string): string {
  const continued = continueList(previous, next)
  return continued !== next ? continued : completeTaskBox(previous, next)
}
