/**
 * #746 — exactly one production path carries a question into the owner's chat.
 *
 * The real vocabulary is not `askOwner`: an ambiguous merge raises a
 * `TridentMergeConflictEscalation`, and the asking boundary is the place where its
 * `.question` becomes a terminal run's `failure_reason`. Terminal delivery sends that
 * reason to the run's recorded chat. Enumerate that boundary directly so the sanctioned
 * path is also the positive control for the search: zero and two matches both fail.
 */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ASKING_BOUNDARY = String.raw`failedRun\([^\n]*\.question`
const SCOPES = ['trident', 'gateway', 'open', 'runtime', 'agent-dispatch']

test('exactly one production path asks the owner, with the sanctioned path as positive control', () => {
  const search = spawnSync(
    'rg',
    [
      '--line-number',
      '--no-heading',
      '--glob',
      '*.ts',
      '--glob',
      '!*.test.ts',
      '--glob',
      '!**/__tests__/**',
      ASKING_BOUNDARY,
      ...SCOPES,
    ],
    { cwd: REPO, encoding: 'utf8' },
  )

  expect(search.error).toBeUndefined()
  expect(search.status === 0 || search.status === 1).toBe(true)
  const matches = search.stdout.trim() === '' ? [] : search.stdout.trim().split('\n')

  // One assertion proves both halves: the search must see the known path, and the same
  // invocation must not see a second path anywhere in the enumerated production scopes.
  expect(matches).toEqual([
    expect.stringMatching(/^trident\/orchestrator\.ts:\d+:\s+run: \{ \.\.\.failedRun\(doneRun, err\.question, true\),/),
  ])
})
