import { expect, test } from 'bun:test'

import { normalizeAction, workflowSignature } from '../signature.ts'
import type { CompletedWorkflow } from '../types.ts'

// --- normalizeAction: matching behaviour is pinned exactly ----------------
// The trailing "(...)" strip was reimplemented as a linear scan to kill the
// `js/polynomial-redos` backtracking in `/\s*\(.*\)\s*$/`; these cases pin the
// *exact* behaviour of the old regex (greedy `.*`: first `(` through the last
// `)` that is followed only by whitespace, plus the whitespace before it).

test('normalizeAction lowercases, collapses whitespace, and drops a trailing arg tail', () => {
  expect(normalizeAction('Create File (path=a)')).toBe('create file')
  expect(normalizeAction('  TX-Scrape   (url=x)  ')).toBe('tx-scrape')
  expect(normalizeAction('doc_write')).toBe('doc_write')
})

test('normalizeAction strips the tail greedily through NESTED parens (regex parity)', () => {
  // Old `/\s*\(.*\)\s*$/` matched from the first `(` to the LAST `)` — the
  // whole " (a (b))" tail is removed, not just the inner group.
  expect(normalizeAction('search (query=(foo))')).toBe('search')
  expect(normalizeAction('a (b (c) d)')).toBe('a')
})

test('normalizeAction leaves a non-trailing paren group intact (regex parity)', () => {
  // The `)` is not the last non-whitespace char, so the regex never matched.
  expect(normalizeAction('a (b) c')).toBe('a (b) c')
  // An unbalanced lone `(` is not a tail either.
  expect(normalizeAction('open ( now')).toBe('open ( now')
})

test('normalizeAction does not backtrack catastrophically on adversarial paren input', () => {
  // `'('.repeat(n)` is the pathological case for the old `/\s*\(.*\)\s*$/`:
  // `.*` matches to end, fails to find `\)`, then the engine restarts the
  // match at every offset — O(n²). The linear scan returns it unchanged.
  //
  // ISSUES #438 — the guard is the TEST TIMEOUT, not a `<50ms` assertion. The
  // regression is a HANG (a quadratic scan of 500k chars is ~2 minutes), not a
  // near-miss, so a millisecond budget guards the wrong distance: it sat ~39x
  // from the passing case (measured ~1.3 ms) while the failure is ~36,000x
  // away. The timeout catches the real shape with far more slack.
  const evil = '('.repeat(500_000)
  const out = normalizeAction(evil)
  expect(out).toBe(evil)
})

test('workflowSignature is stable across volatile args (uses normalizeAction)', () => {
  const wf = (a: string, b: string): CompletedWorkflow => ({
    project_slug: 'p',
    intent: 'x',
    steps: [{ action: a }, { action: b }],
    artifacts: [],
    succeeded: true,
  })
  const sig1 = workflowSignature(wf('Edit File (path=foo)', 'Run Tests (suite=a)'))
  const sig2 = workflowSignature(wf('edit file (path=bar)', 'run tests (suite=z)'))
  expect(sig1).toBe(sig2)
})
