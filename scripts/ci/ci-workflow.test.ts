/**
 * #321 — guard the CI workflow's PR trigger + concurrency keying.
 *
 * PR #10 (a slashed `feat/google-workspace-...` head) merged with only
 * CodeQL+Analyze signal: the ci.yml `test` job never fired. Root cause was the
 * `concurrency: ci-${{ github.ref }}` group — keying on a ref whose shape
 * varies by branch name let the `test` run be superseded/skipped for some
 * branch shapes. The fix keys PR runs on the PR NUMBER (always slash-free),
 * namespaced by workflow, so every PR to main gets its own independent `test`
 * run regardless of head-branch name.
 *
 * This is a text-level guard (the repo has no YAML parser dependency): it
 * asserts the trigger + concurrency invariants that keep the `test` gate
 * firing, so a regression to the old `ci-${{ github.ref }}` form fails CI.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CI_YML = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const yml = readFileSync(CI_YML, 'utf8')

describe('#321 ci.yml test-gate always fires on PRs to main', () => {
  test('triggers on pull_request with no branch/type filter that could exclude PRs', () => {
    // `pull_request:` present with no nested `branches:`/`types:` narrowing.
    expect(yml).toMatch(/^on:\n(?:.*\n)*?\s{2}pull_request:\s*\n/m)
    // The pull_request key must be bare (next non-blank line is another top-level
    // `on:` key, not an indented filter under pull_request).
    expect(yml).not.toMatch(/pull_request:\s*\n\s+branches:/)
    expect(yml).not.toMatch(/pull_request:\s*\n\s+paths:/)
  })

  test('concurrency keys PR runs on the slash-free PR number, not the raw ref', () => {
    // The fixed pattern: PR number (slash-free) || ref, namespaced by workflow.
    expect(yml).toContain('github.event.pull_request.number || github.ref')
    // The regressed pattern must be gone.
    expect(yml).not.toMatch(/group:\s*ci-\$\{\{\s*github\.ref\s*\}\}/)
  })

  test('defines the `test` job', () => {
    expect(yml).toMatch(/^\s{2}test:\s*$/m)
  })
})
