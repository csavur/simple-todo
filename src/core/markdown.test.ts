import { assert, test } from 'orca/testing'
import { assistMarkdown, completeTaskBox, continueList } from './markdown.ts'

test('Enter after a bullet starts the next bullet', () => {
  assert.equal(continueList('- one', '- one\n'), '- one\n- ')
  assert.equal(continueList('  * one', '  * one\n'), '  * one\n  * ')
})

test('Enter after a numbered item counts up', () => {
  assert.equal(continueList('1. one', '1. one\n'), '1. one\n2. ')
  assert.equal(continueList('9) nine', '9) nine\n'), '9) nine\n10) ')
})

test('Enter after a task box starts an unticked one', () => {
  assert.equal(continueList('- [x] done', '- [x] done\n'), '- [x] done\n- [ ] ')
})

test('Enter on an empty item ends the list', () => {
  assert.equal(continueList('- one\n- ', '- one\n- \n'), '- one\n')
  assert.equal(continueList('- [ ] ', '- [ ] \n'), '')
})

test('Enter in the middle of the text continues the list there', () => {
  assert.equal(continueList('- one\ntail', '- one\n\ntail'), '- one\n- \ntail')
})

test('Enter that splits an item, or follows plain text, is left alone', () => {
  assert.equal(continueList('- one two', '- one\n two'), '- one\n two')
  assert.equal(continueList('plain', 'plain\n'), 'plain\n')
})

test('edits that are not one typed Enter are left alone', () => {
  assert.equal(continueList('- one', '- one\n\n'), '- one\n\n')
  assert.equal(continueList('- one', '- on'), '- on')
  assert.equal(continueList('', '- pasted\n'), '- pasted\n')
})

test('[ after a list marker becomes a task box', () => {
  assert.equal(completeTaskBox('- ', '- ['), '- [ ] ')
  assert.equal(completeTaskBox('1. ', '1. ['), '1. [ ] ')
  assert.equal(completeTaskBox('- buy milk', '- [buy milk'), '- [ ] buy milk')
})

test('[ elsewhere, or before an existing box, is left alone', () => {
  assert.equal(completeTaskBox('see ', 'see ['), 'see [')
  assert.equal(completeTaskBox('- text ', '- text ['), '- text [')
  assert.equal(completeTaskBox('- ] x', '- [] x'), '- [] x')
})

test('assistMarkdown applies whichever helper fits', () => {
  assert.equal(assistMarkdown('- one', '- one\n'), '- one\n- ')
  assert.equal(assistMarkdown('- ', '- ['), '- [ ] ')
  assert.equal(assistMarkdown('abc', 'abcd'), 'abcd')
})
