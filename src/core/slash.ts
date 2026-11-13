// The "/" menu of the task editor: type "/" to pick a kind of Markdown, as in Notion. Pure
// text in, text out, so the rules are tested without a browser.

export interface SlashCommand {
  id: string
  label: string
  /** What it writes, shown beside the label. */
  hint: string
  /** A short glyph for the menu. */
  glyph: string
  /** Extra words that find it. */
  keywords: readonly string[]
  /** `block` changes what kind of line this is; `inline` wraps text at the caret. */
  kind: 'block' | 'inline' | 'fence'
  /** block: the line's new marker. inline: what goes before the caret. */
  before: string
  /** inline: what goes after the caret. */
  after?: string
  /** inline: text put between, selected so typing replaces it. */
  sample?: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'heading', label: 'Heading', hint: '#', glyph: 'H', keywords: ['title', 'h1'], kind: 'block', before: '# ' },
  { id: 'bullet', label: 'Bullet list', hint: '-', glyph: '•', keywords: ['ul', 'unordered', 'list'], kind: 'block', before: '- ' },
  { id: 'number', label: 'Numbered list', hint: '1.', glyph: '1.', keywords: ['ol', 'ordered', 'list'], kind: 'block', before: '1. ' },
  { id: 'todo', label: 'Checklist', hint: '- [ ]', glyph: '☐', keywords: ['task', 'checkbox', 'todo', 'box'], kind: 'block', before: '- [ ] ' },
  { id: 'quote', label: 'Quote', hint: '>', glyph: '”', keywords: ['blockquote'], kind: 'block', before: '> ' },
  { id: 'codeblock', label: 'Code block', hint: '```', glyph: '{}', keywords: ['fence', 'snippet', 'pre'], kind: 'fence', before: '```' },
  { id: 'bold', label: 'Bold', hint: '**text**', glyph: 'B', keywords: ['strong'], kind: 'inline', before: '**', after: '**', sample: 'bold' },
  { id: 'italic', label: 'Italic', hint: '*text*', glyph: 'I', keywords: ['emphasis', 'em'], kind: 'inline', before: '*', after: '*', sample: 'italic' },
  { id: 'strike', label: 'Strikethrough', hint: '~~text~~', glyph: 'S', keywords: ['del', 'cross'], kind: 'inline', before: '~~', after: '~~', sample: 'text' },
  { id: 'code', label: 'Inline code', hint: '`code`', glyph: '<>', keywords: ['mono'], kind: 'inline', before: '`', after: '`', sample: 'code' },
  { id: 'link', label: 'Link', hint: '[text](url)', glyph: '↗', keywords: ['url', 'href'], kind: 'inline', before: '[', after: '](https://)', sample: 'text' }
]

const MAX_QUERY_LENGTH = 20

export interface SlashQuery {
  /** Where the "/" is. */
  start: number
  /** What was typed after it. */
  query: string
}

/**
 * The "/" token the caret is at the end of, if any. It counts only at the start of a line or
 * after a space, so a path or a date such as `a/b` or `1/2` never opens the menu.
 */
export function slashQuery(text: string, caret: number): SlashQuery | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const start = text.lastIndexOf('/', caret - 1)
  if (start < lineStart) {
    return null
  }
  const query = text.slice(start + 1, caret)
  const previous = start === lineStart ? '' : text[start - 1]
  if (!/^[a-z0-9]*$/i.test(query) || query.length > MAX_QUERY_LENGTH || (previous !== '' && !/\s/.test(previous))) {
    return null
  }
  return { start, query }
}

/** The commands a query finds: those whose name or a keyword starts with it first, then those containing it. */
export function matchSlash(query: string): SlashCommand[] {
  const needle = query.toLowerCase()
  if (!needle) {
    return [...SLASH_COMMANDS]
  }
  const words = (command: SlashCommand) => [command.label.toLowerCase(), ...command.label.toLowerCase().split(' '), ...command.keywords]
  const starts = SLASH_COMMANDS.filter((command) => words(command).some((word) => word.startsWith(needle)))
  const contains = SLASH_COMMANDS.filter(
    (command) => !starts.includes(command) && words(command).some((word) => word.includes(needle))
  )
  return [...starts, ...contains]
}

export interface SlashResult {
  text: string
  selectionStart: number
  selectionEnd: number
}

// The marker a line already has: heading, quote, bullet or number, with an optional task box.
const BLOCK_MARKER = /^(\s*)(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/

/** Replaces the "/query" (from `slash.start` to `caret`) with what the command writes. */
export function applySlash(text: string, slash: SlashQuery, caret: number, command: SlashCommand): SlashResult {
  const head = text.slice(0, slash.start)
  const tail = text.slice(caret)

  if (command.kind === 'inline') {
    const sample = command.sample ?? ''
    const start = head.length + command.before.length
    return {
      text: head + command.before + sample + (command.after ?? '') + tail,
      selectionStart: start,
      selectionEnd: start + sample.length
    }
  }

  if (command.kind === 'fence') {
    // A fence stands on lines of its own.
    const open = `${head && !head.endsWith('\n') ? '\n' : ''}${command.before}\n`
    const close = `\n${command.before}${tail && !tail.startsWith('\n') ? '\n' : ''}`
    const at = head.length + open.length
    return { text: head + open + close + tail, selectionStart: at, selectionEnd: at }
  }

  // A block command sets the kind of the whole line, replacing a marker it already has.
  const lineStart = head.lastIndexOf('\n') + 1
  const line = head.slice(lineStart)
  const [marker, indent] = BLOCK_MARKER.exec(line) as RegExpExecArray
  const rest = line.slice(marker.length)
  const rebuilt = head.slice(0, lineStart) + indent + command.before + rest
  return { text: rebuilt + tail, selectionStart: rebuilt.length, selectionEnd: rebuilt.length }
}
