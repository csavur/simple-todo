// Markdown to HTML for task text. The panel draws its own HTML, so this is the one place task
// text becomes markup: every character of it is escaped, and only the tags written here are
// ever produced. Covers what a to-do needs: paragraphs, headings, lists with task boxes,
// quotes, code, emphasis and links.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only web and mail links are followed; anything else stays plain text. */
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null
}

/** Inline Markdown in text that is already HTML-escaped. */
function inline(escaped: string): string {
  // Code spans first, set aside so nothing inside them is read as Markdown.
  const codes: string[] = []
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, '&'))
    // The panel opens links itself (data-href), so no navigation happens inside the frame.
    return href ? `<a data-act="link" data-href="${escapeHtml(href)}">${label}</a>` : whole
  })
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)])
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/

export interface MarkdownOptions {
  /** Added to each task box as `data-id`, so a click can find the task it belongs to. */
  boxId?: string
  /** Task boxes are drawn but cannot be ticked. */
  readOnly?: boolean
}

/** Renders Markdown as HTML. Task boxes are numbered in order (`data-box`), as `toggleTaskBox` counts them. */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let box = 0
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map((line) => inline(escapeHtml(line))).join('<br>')}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${list.items.join('')}</${tag}>`)
      list = null
    }
  }
  const flush = () => {
    flushParagraph()
    flushList()
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      // One size for every level: a task is not a document.
      out.push(`<h4>${inline(escapeHtml(heading[2]))}</h4>`)
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      out.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`)
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flushParagraph()
      const [, indent, , number, tick, rest] = item
      const ordered = number !== undefined
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      const depth = Math.min(3, Math.floor(indent.replace(/\t/g, '  ').length / 2))
      const content = inline(escapeHtml(rest))
      if (tick === undefined) {
        list.items.push(`<li class="depth-${depth}">${content}</li>`)
      } else {
        const checked = tick !== ' '
        const attributes = [
          'type="checkbox"',
          'data-act="box"',
          `data-box="${box++}"`,
          options.boxId ? `data-id="${escapeHtml(options.boxId)}"` : '',
          checked ? 'checked' : '',
          options.readOnly ? 'disabled' : ''
        ]
          .filter(Boolean)
          .join(' ')
        list.items.push(
          `<li class="task depth-${depth}${checked ? ' ticked' : ''}"><label><input ${attributes}><span>${content}</span></label></li>`
        )
      }
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flush()
  return out.join('')
}

const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/

/** Ticks or unticks the `index`-th task box of the text, counted as `renderMarkdown` numbers them. */
export function toggleTaskBox(source: string, index: number): string {
  let seen = 0
  let fenced = false
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced || !TASK_BOX.test(line)) {
        return line
      }
      return seen++ === index
        ? line.replace(TASK_BOX, (_, before: string, tick: string, after: string) =>
            `${before}${tick === ' ' ? 'x' : ' '}${after}`
          )
        : line
    })
    .join('\n')
}
