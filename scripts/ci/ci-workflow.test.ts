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
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CI_YML = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const yml = readFileSync(CI_YML, 'utf8')

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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

/**
 * G5 — typecheck completeness.
 *
 * The old gate ran only the root `tsc --noEmit`, whose include list never
 * reached trident/, app/, work-board/, project-credentials/, jwt-validator/,
 * landing/chat-react/, or their test files — so real type errors shipped
 * invisibly. The fix runs `tsc -p` for EVERY tsconfig on disk via
 * `scripts/ci/typecheck-all.sh`. These tests pin two invariants so the class of
 * "a package silently escapes typechecking" cannot regress:
 *
 *  1. CI invokes the matrix script (not a single bare `tsc --noEmit`), and the
 *     script's dynamic discovery covers EVERY tsconfig.json on disk — proven by
 *     an INDEPENDENT filesystem walk here, so a narrowed `find` in the script is
 *     caught even though the script uses `find` internally.
 *  2. Server configs (root + shared base) do NOT ship the DOM lib, so browser
 *     globals like `document` cannot typecheck inside server code; browser
 *     leaves (landing) still own DOM.
 */
describe('G5 CI typechecks every tsconfig on disk', () => {
  const MATRIX_SH = join(REPO_ROOT, 'scripts/ci/typecheck-all.sh')

  // Independent enumeration: walk the repo ourselves, skipping node_modules,
  // and collect every file literally named `tsconfig.json`.
  function findTsconfigsOnDisk(): string[] {
    const out: string[] = []
    const walk = (abs: string) => {
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue
        const child = join(abs, ent.name)
        if (ent.isDirectory()) walk(child)
        else if (ent.name === 'tsconfig.json')
          out.push(relative(REPO_ROOT, child))
      }
    }
    walk(REPO_ROOT)
    return out.sort()
  }

  test('ci.yml runs the tsc-matrix script, not a single bare `tsc --noEmit`', () => {
    expect(yml).toContain('scripts/ci/typecheck-all.sh')
    // The regressed single-config gate must be gone (the matrix script is the
    // only typecheck entrypoint).
    expect(yml).not.toMatch(/run:\s*bunx tsc --noEmit\s*$/m)
  })

  test('the matrix (--list) covers every tsconfig.json on disk', () => {
    const listed = execFileSync('bash', [MATRIX_SH, '--list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()

    const onDisk = findTsconfigsOnDisk()

    // Every tsconfig the matrix script would check must exist on disk, and every
    // tsconfig on disk must be in the matrix — set equality proves completeness.
    expect(listed).toEqual(onDisk)
    // Sanity: the previously-escaping packages are now in the matrix.
    for (const must of [
      'tsconfig.json',
      'trident/tsconfig.json',
      'app/tsconfig.json',
      'work-board/tsconfig.json',
      'project-credentials/tsconfig.json',
      'jwt-validator/tsconfig.json',
      'landing/chat-react/tsconfig.json',
    ]) {
      expect(listed).toContain(must)
    }
  })

  test('server configs (root + base) do NOT ship the DOM lib', () => {
    const readLib = (rel: string): string[] => {
      const raw = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // Strip // line comments so JSONC parses.
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
      return json.compilerOptions?.lib ?? []
    }
    expect(readLib('tsconfig.json')).not.toContain('DOM')
    expect(readLib('tsconfig.base.json')).not.toContain('DOM')
  })

  test('browser leaves still own the DOM lib', () => {
    const landing = JSON.parse(
      readFileSync(join(REPO_ROOT, 'landing/tsconfig.json'), 'utf8').replace(
        /^\s*\/\/.*$/gm,
        '',
      ),
    )
    expect(landing.compilerOptions.lib).toContain('DOM')
  })
})
