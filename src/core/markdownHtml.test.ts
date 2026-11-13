import { assert, test } from 'orca/testing'
import { escapeHtml, renderMarkdown, toggleTaskBox } from './markdownHtml.ts'

test('escapes everything a task holds', () => {
  assert.equal(escapeHtml(`<b a="1" b='2'>&`), '&lt;b a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;')
  assert.equal(
    renderMarkdown('<img src=x onerror=alert(1)> **<i>bold</i>**'),
    '<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;i&gt;bold&lt;/i&gt;</strong></p>'
  )
})

test('renders paragraphs, emphasis, code and headings', () => {
  assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>')
  assert.equal(
    renderMarkdown('**b** *i* _i_ ~~s~~ `a*b*`'),
    '<p><strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>a*b*</code></p>'
  )
  assert.equal(renderMarkdown('## Title'), '<h4>Title</h4>')
  assert.equal(renderMarkdown('> quoted'), '<blockquote>quoted</blockquote>')
  assert.equal(renderMarkdown('snake_case_name 2*3*4'), '<p>snake_case_name 2*3*4</p>')
})

test('renders fenced code without reading Markdown inside it', () => {
  assert.equal(
    renderMarkdown('```\n- [ ] **x** <tag>\n```'),
    '<pre><code>- [ ] **x** &lt;tag&gt;</code></pre>'
  )
})

test('follows only web and mail links', () => {
  assert.equal(
    renderMarkdown('[docs](https://example.com/a?b=1&c=2)'),
    '<p><a data-act="link" data-href="https://example.com/a?b=1&amp;c=2">docs</a></p>'
  )
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>')
})

test('renders lists, numbering task boxes in order', () => {
  assert.equal(
    renderMarkdown('- a\n  - b\n1. c'),
    '<ul><li class="depth-0">a</li><li class="depth-1">b</li></ul><ol><li class="depth-0">c</li></ol>'
  )
  const html = renderMarkdown('- [ ] one\n- [x] two', { boxId: 'a"b' })
  assert.ok(html.includes('<input type="checkbox" data-act="box" data-box="0" data-id="a&quot;b">'))
  assert.ok(html.includes('<input type="checkbox" data-act="box" data-box="1" data-id="a&quot;b" checked>'))
  assert.ok(html.includes('<li class="task depth-0 ticked">'))
  assert.ok(renderMarkdown('- [ ] one', { readOnly: true }).includes('disabled'))
})

test('toggleTaskBox ticks the box that was clicked', () => {
  const text = 'Intro\n- [ ] one\n```\n- [ ] not a box\n```\n1. [x] two\n- plain'
  assert.equal(toggleTaskBox(text, 0), text.replace('- [ ] one', '- [x] one'))
  assert.equal(toggleTaskBox(text, 1), text.replace('1. [x] two', '1. [ ] two'))
  assert.equal(toggleTaskBox(text, 5), text)
})
