import { expect, test } from 'bun:test'
import { claudeComposerEmpty } from './claude-composer.ts'

test.each([
  '────────\n❯\n────────\n? for shortcuts',
  'previous ❯ draft\n────────\n❯  \n────────\n\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent\n\n\n',
  '  ────────\n  ❯\n  ────────\n? for shortcuts',
  '\x1b[32m────────\n❯\x1b[0m\n────────\n  ● main\n  ◯ general-purpose  Confirming clean state  49m 15s',
])('accepts the current empty rendered composer: %s', screen => {
  expect(claudeComposerEmpty(screen)).toBe(true)
})

test.each([
  '', '❯', 'Some output\n❯\nMore output',
  '────────\n❯ unsent owner draft\n────────\n? for shortcuts',
  '────────\n❯\n  continuation of a multiline draft\n────────\n? for shortcuts',
  '────────\n❯ quoted composer\n  ────────\n  ❯\n────────\n? for shortcuts',
  '────────\n  ❯\n────────\n? for shortcuts',
  '────────\n❯ [Pasted text #1 +10 lines]\n────────\n? for shortcuts',
  '────────\n❯\n────────\nWorking (esc to interrupt)',
  '────────\n❯\n────────\n❯ next owner draft',
  '────────\n❯\n────────\nSelect model\n❯ 1. Default\nEsc to cancel',
  '────────\n❯\n────────\n' + Array(13).fill('later output').join('\n'),
])('refuses occupied, working, historical and unknown composers: %s', screen => {
  expect(claudeComposerEmpty(screen)).toBe(false)
})
