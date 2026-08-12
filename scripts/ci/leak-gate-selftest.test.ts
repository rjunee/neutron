/**
 * Unit G8 (Part A) — self-tests for scripts/ci/leak-gate.sh, the public purity
 * gate that had ZERO tests. (The NUL binary-hiding tripwire is covered
 * separately by leak-gate-nul-tripwire.test.ts; this suite covers the broader
 * vocabulary + structural rules and the clean-tree silence baseline.)
 *
 * Every case runs the REAL gate against a THROWAWAY fixture tree we populate —
 * never the real repo — so the assertions don't depend on the repo staying
 * clean. A fixture with PLANTED findings must FAIL (naming the right rule); a
 * clean fixture must be SILENT.
 *
 * NOTE: the forbidden tokens this suite plants are assembled from FRAGMENTS at
 * runtime (below), never written as literals, so this test's own source never
 * trips the very gate it drives. The throwaway fixtures still receive the real,
 * fully-assembled tokens — only this source file stays clean.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEAK_GATE = fileURLToPath(new URL('./leak-gate.sh', import.meta.url))
const PROSE_AWK = fileURLToPath(new URL('./extract-comment-prose.awk', import.meta.url))
const REPO_LICENSE = fileURLToPath(new URL('../../LICENSE', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// Retired / forbidden tokens, fragment-assembled (see file header).
const T2 = 'ten' + 'ant' // retired multi-org vocab root
const CODE_TOKEN = `${T2}_slug` // a retired code identifier
const HOSTED = 'neutron' + '.' + 'computer' // hosted product domain (rule stays armed)
// The structural private-system path token. Fragment-assembled for the same
// reason as the rest: this source file must never itself carry the literal.
const PRIVATE_TOKEN = 'va' + 'jra'

/**
 * Build a child env with every `GITHUB_*` / `LEAK_GATE_*` variable REMOVED, plus
 * whatever `extra` the case wants.
 *
 * Since the 2026-07-29 fail-closed change, the gate's behaviour depends on its
 * secret-access context. Inside GitHub Actions this suite would inherit
 * `GITHUB_ACTIONS=true`, be judged `canonical`, and exit 2 on every fixture for a
 * missing denylist — so the context is always pinned explicitly here. That also
 * makes the context itself testable: a case that wants `canonical` says so.
 */
function gateEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GITHUB_') || k.startsWith('LEAK_GATE_') || v === undefined) continue
    env[k] = v
  }
  // Since the 2026-07-30 local-denylist change the gate ALSO reads a file under
  // `$XDG_CONFIG_HOME`/`$HOME`, neither of which is scrubbed above (nor can be —
  // git and bash need them). On a maintainer's machine that file exists, so
  // without this pin every "no denylist available" case below would quietly
  // become a "denylist loaded" case and stop testing what it says it tests. The
  // path is pinned to one that cannot exist; cases that WANT a file override it.
  return {
    LEAK_GATE_PII_DENYLIST_FILE: '/nonexistent/leak-gate/denylist-absent',
    ...env,
    ...extra,
  }
}

/** base64 of a newline-separated denylist, the shape the workflow ships. */
function denylistB64(entries: string[]): string {
  return Buffer.from(`${entries.join('\n')}\n`, 'utf8').toString('base64')
}

function runGate(
  dir: string,
  extraEnv: Record<string, string> = {},
  script: string = LEAK_GATE,
): { code: number; out: string } {
  try {
    // `2>&1` merges stderr into stdout. execFileSync returns ONLY stdout on
    // success, and the gate announces its sanctioned Tier-1 skip on stderr — so
    // without this merge the success path silently loses the very line that
    // distinguishes "the rule ran" from "the rule was skipped".
    // `LEAK_GATE_MODE_ARGS` is a HARNESS knob, not a gate feature — it lets a
    // case append a flag (currently only `--messages-only`) without every
    // existing call site growing a fourth positional argument. The gate itself
    // never reads the variable.
    const out = execFileSync('bash', ['-c', '"$0" --tree "$1" ${LEAK_GATE_MODE_ARGS:-} 2>&1', script, dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gateEnv(extraEnv),
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** A tree the gate passes cleanly: real Apache LICENSE + one innocuous source. */
function freshTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-gate-selftest-'))
  copyFileSync(REPO_LICENSE, join(dir, 'LICENSE'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')
  return dir
}

/**
 * A `freshTree()` that is also a real git repo with `commitSubjects` layered on
 * top of a clean base commit. Needed by every case that exercises the
 * commit-message scan, and by any case running in a simulated CI context (where
 * an un-scannable message range is itself a hard failure).
 */
function gitFixture(
  commitSubjects: string[] = [],
  author?: string,
): { dir: string; base: string } {
  const dir = freshTree()
  const g = (...a: string[]): string =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  g('init', '-q')
  g('config', 'user.email', 'selftest@example.invalid')
  g('config', 'user.name', 'leak-gate selftest')
  g('config', 'commit.gpgsign', 'false')
  g('add', 'LICENSE', 'src/clean.ts')
  g('commit', '-q', '-m', 'base commit')
  const base = g('rev-parse', 'HEAD')
  commitSubjects.forEach((subject, i) => {
    writeFileSync(join(dir, 'src', `c${i}.ts`), `export const c${i} = ${i}\n`)
    g('add', `src/c${i}.ts`)
    // `author` overrides ONLY the layered commits, never the base — so a case can
    // plant an identity inside the scan window and leave the pre-window history
    // clean, which is the shape the gate has to distinguish.
    if (author === undefined) g('commit', '-q', '-m', subject)
    else g('commit', '-q', '-m', subject, `--author=${author}`)
  })
  return { dir, base }
}

/**
 * A copy of the gate, installed INSIDE the fixture tree, with a CUSTOM allowlist.
 * The gate resolves its allowlist relative to its own `BASH_SOURCE`, so this is
 * the only way to drive the allowlist audit without touching the committed file —
 * and it needs no flag, env knob or second code path inside the gate.
 *
 * It goes under `node_modules/` for two reasons, both load-bearing:
 *  - the `allowlist-stale` rule only applies when the allowlist OWNS the scanned
 *    tree (the script lives inside it), which is exactly what this arranges; and
 *  - `node_modules/` is excluded from the scan, so the copied gate does not
 *    self-match the retired-vocab rules it defines and turn every case red.
 */
function sandboxGate(dir: string, allowlist: string): string {
  const d = join(dir, 'node_modules', 'leak-gate')
  mkdirSync(d, { recursive: true })
  copyFileSync(LEAK_GATE, join(d, 'leak-gate.sh'))
  copyFileSync(PROSE_AWK, join(d, 'extract-comment-prose.awk'))
  writeFileSync(join(d, 'leak-gate-allowlist.txt'), allowlist)
  return join(d, 'leak-gate.sh')
}

describe('G8 leak-gate — clean baseline', () => {
  test('a clean fixture tree is SILENT', () => {
    const dir = freshTree()
    try {
      // A denylist is supplied so this asserts a REAL green. Without one the gate
      // now (correctly) reports INCOMPLETE — "SILENT" would be a claim about a
      // rule that never ran.
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_B64: DENYLIST })
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G8 leak-gate — planted findings FAIL', () => {
  test('a retired-vocab CODE token trips the code rule', () => {
    const dir = freshTree()
    try {
      // A retired live-surface identifier that must never re-enter the tree.
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-code]`)
      expect(out).toContain('LEAK GATE: FAIL')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('retired-vocab PROSE in a comment trips the Tier-2 prose rule', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'note.ts'), `// each ${T2} gets an isolated db\nexport const x = 1\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-word]`)
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the hosted product domain trips the self-host-only rule', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'url.ts'), `export const host = "https://app.${HOSTED}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain('[neutron-computer]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a NUL-carrying source (token hidden from grep) trips binary-hidden', () => {
    const dir = freshTree()
    try {
      // A raw NUL makes grep -I skip the file; the tripwire must still catch it.
      writeFileSync(join(dir, 'src', 'sneaky.ts'), `const k = "a\x00${CODE_TOKEN}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain('[binary-hidden]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a forbidden Managed structural path trips forbidden-path', () => {
    const dir = freshTree()
    try {
      mkdirSync(join(dir, 'signup'))
      writeFileSync(join(dir, 'signup', 'index.ts'), 'export const x = 1\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[forbidden-path]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the retained forbidden root files each trip forbidden-path', () => {
    // K10 un-banned SPEC.md but the remaining FORBIDDEN_EXACT entries stay
    // banned as carve tripwires against Managed's private root docs re-entering
    // the public tree. Pin EACH one individually so deleting any entry from the
    // list fails this suite (Codex P2 — the `signup/` prefix test alone did not
    // cover FORBIDDEN_EXACT).
    for (const name of ['STATUS.md', 'ISSUES.md', 'CLAUDE.md', 'AGENTS.md']) {
      const dir = freshTree()
      try {
        writeFileSync(join(dir, name), '# forbidden root file\n')
        const { code, out } = runGate(dir)
        expect(out).toContain('[forbidden-path]')
        expect(out).toContain(name)
        expect(out).toContain('LEAK GATE: FAIL')
        expect(code).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    // Four full gate runs in one case. bun's 5s default is the wrong budget for
    // a test that shells out repeatedly (same reasoning as ci-workflow.test.ts).
  }, 60_000)

  test('RT1: a root SPEC.md is allowed (K10 intentionally introduced one)', () => {
    // K10 lands a real root `SPEC.md` (the public master spec), which flips the
    // repo into Ralph-governed mode (`detectRalphMode` keys off a root SPEC.md).
    // That flip is now INTENDED, so a root SPEC.md must NOT trip forbidden-path.
    // This test is the inversion of the pre-K10 tripwire, which banned a root
    // SPEC.md; it pins that an otherwise-clean tree WITH a root SPEC.md stays
    // silent. The remaining root files (STATUS.md/ISSUES.md/CLAUDE.md/AGENTS.md)
    // stay banned — covered by the "forbidden Managed structural path" test and
    // the FORBIDDEN_EXACT list.
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'SPEC.md'), '# spec\n')
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_B64: DENYLIST })
      expect(out).not.toContain('[forbidden-path]')
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('RT1: a NON-root SPEC.md is allowed (forbidden-path is root-exact)', () => {
    // The tripwire bans a *root* SPEC.md only — `detectRalphMode` keys off the
    // git-root file. A nested `docs/SPEC.md` (or any subdir spec) must NOT trip
    // the gate, or legitimate spec docs would be un-committable. Pins the
    // exact-root boundary of the FORBIDDEN_EXACT rule.
    const dir = freshTree()
    try {
      mkdirSync(join(dir, 'docs'))
      writeFileSync(join(dir, 'docs', 'SPEC.md'), '# a perfectly fine nested spec\n')
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_B64: DENYLIST })
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing/stub LICENSE trips license-stub', () => {
    // No LICENSE copied → the Apache-2.0 check fails.
    const dir = mkdtempSync(join(tmpdir(), 'leak-gate-nolicense-'))
    try {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[license-stub]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('summary tallies multiple planted findings at once', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      writeFileSync(join(dir, 'src', 'url.ts'), `export const host = "${HOSTED}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-code]`)
      expect(out).toContain('[neutron-computer]')
      expect(out).toMatch(/TOTAL FINDINGS: [1-9]/)
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-07-29 — the Tier-1 rule that had never run.
 *
 * `LEAK_GATE_PII_DENYLIST_B64` was read, found unset, WARNED about, skipped, and
 * the gate still exited 0 printing "SILENT ✅" — on every one of ~3,700 CI runs.
 * No workflow ever passed the variable and the repository secret did not exist,
 * so the warning branch was the ONLY branch that ever executed. The cases below
 * pin the fix in both directions; a green gate is not evidence of anything unless
 * a red one is reachable.
 *
 * Every token used here is SYNTHETIC. No real denylist entry appears in this
 * file, in the gate, or in any fixture — the denylist stays out-of-band, which is
 * the whole reason it can be absent in the first place.
 * ──────────────────────────────────────────────────────────────────────────── */

// Synthetic denylist entries. `PATHY` is the path-shaped kind (the default:
// case-insensitive, separator-flexible substring). `EMBEDDED` proves a token
// concatenated into an identifier is caught. `WORDY` is the narrow
// case-sensitive word-bounded kind.
const PATHY = '/opt/acmeowner-home'
const EMBEDDED = 'zorblax'
const WORDY = 'Marble'
const DENYLIST = denylistB64([
  '# synthetic — no real entry ever appears in the repo',
  PATHY,
  EMBEDDED,
  `word:${WORDY}`,
])

const CANONICAL_PUSH = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'example-org/example-repo',
}
const CANONICAL_SAME_REPO_PR = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: 'example-org/example-repo',
  LEAK_GATE_PR_HEAD_REPO: 'example-org/example-repo',
}
const FORK_PR = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: 'example-org/example-repo',
  LEAK_GATE_PR_HEAD_REPO: 'a-contributor/example-repo',
}

describe('Tier-1 denylist is FAIL-CLOSED where secrets are available', () => {
  test('canonical push + NO denylist ⇒ exit 2, not a warning', () => {
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, { ...CANONICAL_PUSH, LEAK_GATE_BASE_SHA: base })
      expect(out).toContain('FATAL')
      expect(out).toContain('LEAK_GATE_PII_DENYLIST_B64')
      // The old behaviour, pinned as forbidden: it must NOT claim success.
      expect(out).not.toContain('LEAK GATE: SILENT')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('canonical SAME-repo PR + NO denylist ⇒ exit 2', () => {
    // A same-repo PR does get secrets, so it gets no exemption.
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, { ...CANONICAL_SAME_REPO_PR, LEAK_GATE_BASE_SHA: base })
      expect(out).toContain('FATAL')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('canonical + UNDECODABLE denylist ⇒ exit 2 (not silently empty)', () => {
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, {
        ...CANONICAL_PUSH,
        LEAK_GATE_BASE_SHA: base,
        // NOTE: `base64 -d` is lenient on macOS (it drops invalid characters
        // rather than erroring), so an "almost base64" string would still decode
        // to something. This value decodes to nothing at all, which is the case
        // that matters: an empty denylist must never be treated as "loaded".
        LEAK_GATE_PII_DENYLIST_B64: '!!!!',
      })
      expect(out).toContain('FATAL')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('FORK PR + NO denylist ⇒ the ONE documented skip, still exit 0', () => {
    // GitHub genuinely withholds secrets from fork PRs. This is the only skip,
    // and it is announced on stderr rather than swallowed.
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, { ...FORK_PR, LEAK_GATE_BASE_SHA: base })
      expect(out).toContain('secret context: fork')
      expect(out).toContain('SKIPPED')
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('canonical + a valid denylist ⇒ the rule actually RUNS and the tree passes', () => {
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, {
        ...CANONICAL_PUSH,
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
      })
      expect(out).toContain('denylist loaded')
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a local run with NO denylist is INCOMPLETE (exit 3), never green', () => {
    // A local run is not a merge gate, so it cannot exit 2 — but "I could not
    // check" must not wear the same verdict as "I checked and it was clean".
    // Until 2026-07-30 it printed SILENT ✅ and exited 0, which is the same lie
    // the CI half of this gate told for ~3,700 runs.
    const dir = freshTree()
    try {
      const { code, out } = runGate(dir)
      expect(out).toContain('secret context: local')
      expect(out).toContain('COULD NOT RUN')
      expect(out).toContain('RULES THAT COULD NOT RUN: pii-denylist')
      expect(out).toContain('LEAK GATE: INCOMPLETE')
      expect(out).not.toContain('LEAK GATE: SILENT')
      expect(code).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-07-30 — the LOCAL half of Tier-1.
 *
 * The denylist is a repository secret, so it existed only inside CI. An author
 * therefore had NO pre-push signal for the one class of leak that cannot be
 * redacted once public: a commit message or PR body, mirrored to GHArchive
 * within the hour. On 2026-07-30 owner names went out in exactly those two
 * fields; CI caught them, the branch was scrubbed and force-pushed, and the
 * original push was already mirrored and unrecoverable.
 *
 * The fix is a denylist file OUTSIDE the repo plus a pre-push hook. Every token
 * used below is a neutral invention (`willow`, `acme`, `orchard`) — the real
 * list stays out-of-band, which is the entire reason it can be absent.
 * ──────────────────────────────────────────────────────────────────────────── */

const LOCAL_TERM = 'willow' // neutral stand-in for a real denylist entry
const PRE_PUSH_HOOK = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url))
const INSTALL_HOOKS = fileURLToPath(new URL('../install-git-hooks.sh', import.meta.url))

/** Write a plain-text denylist to a path OUTSIDE the fixture tree. */
function localDenylistFile(entries: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'leak-gate-denylist-'))
  const f = join(d, 'denylist')
  writeFileSync(f, `${entries.join('\n')}\n`)
  return f
}

describe('local denylist FILE — same rules, no secret', () => {
  test('a file-supplied denylist RUNS the rule and catches a tree token', () => {
    const dir = freshTree()
    const file = localDenylistFile(['# neutral', LOCAL_TERM])
    try {
      writeFileSync(join(dir, 'src', 'leak.ts'), `const p = "/opt/${LOCAL_TERM}/data"\n`)
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_FILE: file })
      expect(out).toContain('denylist loaded from file:')
      expect(out).toContain('[pii-denylist]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('the file source is IGNORED inside CI — the secret is the only CI source', () => {
    // Load-bearing: if a runner-side file could stand in for the secret, the
    // 2026-07-29 fail-closed guarantee would be defeated by planting a file.
    const { dir, base } = gitFixture()
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        ...CANONICAL_PUSH,
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
      })
      expect(out).toContain('FATAL')
      expect(out).not.toContain('denylist loaded')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('the env var still WINS over the file', () => {
    const dir = freshTree()
    const file = localDenylistFile([LOCAL_TERM])
    try {
      // Planted token is in the FILE list only; the env list does not contain it.
      writeFileSync(join(dir, 'src', 'leak.ts'), `const p = "/opt/${LOCAL_TERM}/data"\n`)
      const { code, out } = runGate(dir, {
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
        LEAK_GATE_PII_DENYLIST_FILE: file,
      })
      expect(out).toContain('denylist loaded from env')
      expect(out).not.toContain('[pii-denylist]')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('a MISSING file path is named on stderr, not swallowed', () => {
    const dir = freshTree()
    try {
      const { out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_FILE: '/nope/denylist' })
      expect(out).toContain('no denylist file at: /nope/denylist')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-12 — commit AUTHOR identity was a hole the gate could not see.
 *
 * `git log --format='%s%n%b'` is the message and nothing else, so a denylisted
 * name could sail through in `%an`/`%ae` on every commit of a branch while the
 * gate reported SILENT. It is not a cosmetic field: GitHub's squash merge reads
 * the author of each squashed commit and writes it into a `Co-authored-by:`
 * trailer on the merge commit — i.e. straight into main's message body, the
 * surface this gate does scan, but only once the merge has already published it.
 * That is the exact route by which an owner address reached this repo's main.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('commit AUTHOR identity is scanned, not just the message', () => {
  test('RED on a denylisted name in the AUTHOR of a commit whose MESSAGE is clean', () => {
    // The discriminator: the subject and body carry nothing denylisted, so a gate
    // reading only `%s%n%b` reports SILENT here. Only reading `%an <%ae>` fails it.
    const { dir, base } = gitFixture(
      ['feat: a subject with nothing to hide'],
      `${LOCAL_TERM} maintainer <${LOCAL_TERM}@example.com>`,
    )
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
      })
      // The guarded thing was actually REFUSED: a finding, on the author stream,
      // and a non-zero exit — not merely a line printed somewhere.
      expect(out).toContain('[pii-denylist-msg]')
      expect(out).toContain('COMMIT-AUTHOR')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('a clean author on a clean message stays SILENT — the rule is not always-red', () => {
    const { dir, base } = gitFixture(['feat: a subject with nothing to hide'])
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
      })
      expect(out).not.toContain('[pii-denylist-msg]')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('the STRUCTURAL private-path rule is deliberately NOT applied to identity', () => {
    // `PRIVATE_TOKEN` is the module-level fragment-assembled one, so the literal
    // still never appears in this tree — only at runtime in a temp fixture.
    //
    // This is the decision that the first run of the author rules forced, pinned so
    // a later "tighten it up" cannot flip it silently: the identity that authors
    // nearly every commit in this repo contains that token, so applying the
    // structural path rule to authors would flag EVERY commit of EVERY branch. A
    // rule that fires on 100% of its inputs stops being read, taking the denylist
    // findings printed beside it down with it. The denylist rules still cover the
    // leak this stream exists for — the case above proves that on the same stream.
    const { dir, base } = gitFixture(
      ['feat: a subject with nothing to hide'],
      `agent <${PRIVATE_TOKEN}@example.com>`,
    )
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
      })
      expect(out).not.toContain('[private-path-msg]')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('the pre-push hook path sees it too — this is the PRE-publication control', () => {
    const { dir, base } = gitFixture(
      ['feat: a subject with nothing to hide'],
      `${LOCAL_TERM} maintainer <${LOCAL_TERM}@example.com>`,
    )
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(out).toContain('COMMIT-AUTHOR')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })
})

describe('--messages-only (the pre-push mode)', () => {
  test('RED on a denylisted term in a COMMIT MESSAGE, tree not scanned', () => {
    const { dir, base } = gitFixture([`feat: migrate the ${LOCAL_TERM} archive`])
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(out).toContain('mode: --messages-only')
      expect(out).toContain('[pii-denylist-msg]')
      expect(out).toContain('COMMIT-MESSAGE')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('it does NOT run the tree rules (that is what makes it fast)', () => {
    // A planted TREE finding that the full gate flags must be invisible here —
    // otherwise the mode is not doing what its name and its runtime claim.
    const { dir, base } = gitFixture()
    const file = localDenylistFile([LOCAL_TERM])
    try {
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      const full = runGate(dir, { LEAK_GATE_BASE_SHA: base, LEAK_GATE_PII_DENYLIST_FILE: file })
      expect(full.out).toContain(`[${T2}-code]`)
      expect(full.code).toBe(1)

      const msgs = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(msgs.out).not.toContain(`[${T2}-code]`)
      expect(msgs.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  }, 60_000)

  test('it is REFUSED inside GitHub Actions — never a way to skip the tree scan', () => {
    const { dir, base } = gitFixture()
    try {
      const { code, out } = runGate(dir, {
        ...CANONICAL_PUSH,
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(out).toContain('REFUSED inside GitHub')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('LEAK_GATE_HEAD_SHA bounds the window to what is actually being pushed', () => {
    // `git push origin <sha>:main`, or a push from a non-current branch,
    // publishes something other than HEAD. Scanning HEAD there would flag
    // commits that are staying local while missing the ones going out.
    const { dir, base } = gitFixture(['chore: a clean subject', `feat: the ${LOCAL_TERM} archive`])
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const firstCommit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD~1'], {
        encoding: 'utf8',
      }).trim()

      // Pushing only the first (clean) commit: the later bad one is out of window.
      const partial = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_HEAD_SHA: firstCommit,
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(partial.out).not.toContain('[pii-denylist-msg]')
      expect(partial.code).toBe(0)

      // Pushing the tip: the bad commit IS in window.
      const full = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(full.out).toContain('[pii-denylist-msg]')
      expect(full.code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  }, 60_000)

  test('no resolvable commit range ⇒ exit 2 — it scanned NOTHING', () => {
    const dir = freshTree() // deliberately not a git repo
    const file = localDenylistFile([LOCAL_TERM])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_PII_DENYLIST_FILE: file,
        LEAK_GATE_MODE_ARGS: '--messages-only',
      })
      expect(out).toContain('Nothing was scanned')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })
})

/**
 * A throwaway repo wired the way a real clone is: the gate + hook in place, a
 * bare `origin`, hooks installed via the real installer. Returns a `push()` that
 * performs a REAL `git push` so the hook is exercised by git, not by us calling
 * it — a hook that is only ever invoked directly proves nothing about whether it
 * ever fires.
 */
function pushFixture(denylistEntries: string[] | null): {
  root: string
  commit: (subject: string) => void
  install: () => { code: number; out: string }
  push: () => { code: number; out: string }
  pushWithoutDenylist: () => { code: number; out: string }
  cleanup: () => void
} {
  const sandbox = mkdtempSync(join(tmpdir(), 'leak-gate-prepush-'))
  const root = join(sandbox, 'repo')
  const remote = join(sandbox, 'remote.git')
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true })
  mkdirSync(join(root, '.githooks'), { recursive: true })
  copyFileSync(LEAK_GATE, join(root, 'scripts', 'ci', 'leak-gate.sh'))
  copyFileSync(PROSE_AWK, join(root, 'scripts', 'ci', 'extract-comment-prose.awk'))
  copyFileSync(INSTALL_HOOKS, join(root, 'scripts', 'install-git-hooks.sh'))
  copyFileSync(PRE_PUSH_HOOK, join(root, '.githooks', 'pre-push'))
  // The fixture tree is not the real repo, so the real allowlist's entries would
  // all be `allowlist-stale` here (exit 2, before any rule runs).
  writeFileSync(join(root, 'scripts', 'ci', 'leak-gate-allowlist.txt'), '')
  writeFileSync(join(root, 'app.ts'), 'export const ok = true\n')

  const denylistPath =
    denylistEntries === null ? join(sandbox, 'absent') : localDenylistFile(denylistEntries)
  const env = gateEnv({ LEAK_GATE_PII_DENYLIST_FILE: denylistPath })

  const git = (...a: string[]): string =>
    execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 'selftest@example.invalid')
  git('config', 'user.name', 'leak-gate selftest')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'chore: base commit')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'main')

  const run = (
    args: string[],
    childEnv: Record<string, string> = env,
  ): { code: number; out: string } => {
    try {
      const out = execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      })
      return { code: 0, out }
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  return {
    root,
    commit: (subject: string) => {
      writeFileSync(join(root, `f${Date.now()}.ts`), 'export const x = 1\n')
      git('add', '-A')
      git('commit', '-q', '-m', subject)
    },
    install: () => {
      try {
        const out = execFileSync('bash', [join(root, 'scripts', 'install-git-hooks.sh')], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          cwd: root,
        })
        return { code: 0, out }
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    },
    push: () => run(['push', 'origin', 'main']),
    /** Push with the denylist pointed somewhere else — "the list went missing". */
    pushWithoutDenylist: () =>
      run(['push', 'origin', 'main'], gateEnv({ LEAK_GATE_PII_DENYLIST_FILE: join(sandbox, 'gone') })),
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  }
}

describe('pre-push hook — the control fires before anything is published', () => {
  test('the COMMITTED hook is executable', () => {
    // git will not run a hook without the execute bit — it skips it in silence,
    // which looks exactly like a hook that ran and found nothing. The installer
    // chmods as a belt-and-braces, so a 0644 in the index would be invisible
    // until someone wired the hook a different way. Pin the mode in the index.
    const mode = statSync(PRE_PUSH_HOOK).mode & 0o111
    expect(mode).not.toBe(0)
  })

  test('BLOCKS a real `git push` whose COMMIT MESSAGE carries a denylisted term', () => {
    // THE load-bearing case. Not "the script runs" — an actual push, refused.
    const fx = pushFixture(['# neutral test list', LOCAL_TERM])
    try {
      expect(fx.install().code).toBe(0)
      fx.commit(`feat: migrate the ${LOCAL_TERM} archive`)
      const { code, out } = fx.push()
      expect(out).toContain('[pii-denylist-msg]')
      expect(out).toContain('PUSH BLOCKED')
      expect(code).not.toBe(0)
      // …and the remote must not have moved.
      const remoteHas = execFileSync('git', ['-C', fx.root, 'ls-remote', 'origin', 'main'], {
        encoding: 'utf8',
      })
      const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      expect(remoteHas).not.toContain(head.trim())
    } finally {
      fx.cleanup()
    }
  }, 60_000)

  test('ALLOWS the same push once the message is reworded', () => {
    // The other direction. Without this, a hook that blocked everything would
    // also pass the case above.
    const fx = pushFixture(['# neutral test list', LOCAL_TERM])
    try {
      expect(fx.install().code).toBe(0)
      fx.commit('feat: migrate the archive')
      const { code, out } = fx.push()
      expect(out).not.toContain('PUSH BLOCKED')
      expect(code).toBe(0)
      const remoteHas = execFileSync('git', ['-C', fx.root, 'ls-remote', 'origin', 'main'], {
        encoding: 'utf8',
      })
      const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      expect(remoteHas).toContain(head.trim())
    } finally {
      fx.cleanup()
    }
  }, 60_000)

  test('the installer REFUSES to arm the hook with no denylist', () => {
    // Gate and pattern source ship together or neither is real (2026-07-29).
    const fx = pushFixture(null)
    try {
      const { code, out } = fx.install()
      expect(out).toContain('NOT INSTALLED')
      expect(code).not.toBe(0)
      // Refusing must leave git untouched, not half-armed.
      const cfg = execFileSync('bash', ['-c', `git -C "${fx.root}" config --get core.hooksPath || true`], {
        encoding: 'utf8',
      })
      expect(cfg.trim()).toBe('')
    } finally {
      fx.cleanup()
    }
  }, 60_000)

  test('an ARMED hook BLOCKS when the denylist later disappears', () => {
    // "Could not check" is not "checked and clean". If the file is deleted or
    // renamed after install, the push must stop — the silent-skip version of
    // this is the entire defect being fixed.
    const fx = pushFixture(['# neutral test list', LOCAL_TERM])
    try {
      expect(fx.install().code).toBe(0)
      fx.commit('chore: a perfectly clean subject')
      const armed = fx.push()
      expect(armed.code).toBe(0)

      fx.commit('chore: another perfectly clean subject')
      const { code, out } = fx.pushWithoutDenylist()
      expect(out).toContain('COULD NOT RUN')
      expect(out).toContain('PUSH BLOCKED')
      expect(code).not.toBe(0)
    } finally {
      fx.cleanup()
    }
  }, 60_000)
})

describe('denylist MATCHING — case-insensitive, separator-flexible substring', () => {
  const withDenylist = { LEAK_GATE_PII_DENYLIST_B64: DENYLIST }

  // Each row is a form of the SAME denylist entry. Before the fix, matching was
  // case-SENSITIVE and `\b`-anchored, so a capitalised entry could not match its
  // lowercase path form at all.
  const forms: Array<[string, string]> = [
    ['exact path form', `const p = "${PATHY}/notes.md"`],
    ['hyphen-separated form', `const p = "-opt-acmeowner-home-project"`],
    ['underscore + mixed case', `const p = "/OPT/AcmeOwner_Home"`],
    ['no separators at all', `const p = "optacmeownerhome"`],
  ]
  for (const [label, body] of forms) {
    test(`RED on the ${label}`, () => {
      const dir = freshTree()
      try {
        writeFileSync(join(dir, 'src', 'leak.ts'), `${body}\n`)
        const { code, out } = runGate(dir, withDenylist)
        expect(out).toContain('[pii-denylist]')
        expect(code).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('RED on a token CONCATENATED into an identifier (the `\\b` blind spot)', () => {
    // `\bzorblax\b` matches NEITHER of these: `openZorblaxImport` has no leading
    // boundary and `zorblaxImport` has no trailing one. Substring matching does.
    const dir = freshTree()
    try {
      writeFileSync(
        join(dir, 'src', 'ident.ts'),
        `export const open${EMBEDDED[0]!.toUpperCase()}${EMBEDDED.slice(1)}Import = 1\n`,
      )
      const { code, out } = runGate(dir, withDenylist)
      expect(out).toContain('[pii-denylist]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GREEN once the token is removed (the other direction)', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'leak.ts'), 'const p = "/opt/example/home"\n')
      const { code, out } = runGate(dir, withDenylist)
      expect(out).not.toContain('[pii-denylist]')
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('`word:` entries stay case-SENSITIVE and word-bounded', () => {
    // The narrow exception: a proper noun that is also an ordinary English word.
    // Documented in leak-gate.sh at the compile step; pinned here so the two
    // kinds cannot silently collapse into one.
    const cases: Array<[string, boolean]> = [
      [`A ${WORDY} bench.`, true], // exact proper-noun form ⇒ finding
      [`a ${WORDY.toLowerCase()} bench`, false], // ordinary word ⇒ no finding
      [`${WORDY}s are round`, false], // word-bounded ⇒ no finding
    ]
    for (const [body, shouldFail] of cases) {
      const dir = freshTree()
      try {
        writeFileSync(join(dir, 'src', 'w.ts'), `const s = "${body}"\n`)
        const { code, out } = runGate(dir, withDenylist)
        if (shouldFail) {
          expect(out).toContain('[pii-denylist-word]')
          expect(code).toBe(1)
        } else {
          expect(out).not.toContain('[pii-denylist-word]')
          expect(code).toBe(0)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 60_000)
})

describe('structural private-path rule (needs no secret)', () => {
  test('RED on a tracked PATH carrying the private-system token', () => {
    const dir = freshTree()
    try {
      mkdirSync(join(dir, `${PRIVATE_TOKEN}-import`))
      writeFileSync(join(dir, `${PRIVATE_TOKEN}-import`, 'run.ts'), 'export const x = 1\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[private-path]')
      expect(out).toContain('rename the PATH')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('RED regardless of case in the path', () => {
    const dir = freshTree()
    try {
      const camel = PRIVATE_TOKEN[0]!.toUpperCase() + PRIVATE_TOKEN.slice(1)
      writeFileSync(join(dir, 'src', `${camel}Notes.md`), 'notes\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[private-path]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GREEN when the path is renamed (contents are the denylist’s job)', () => {
    // Deliberate boundary: this rule is PATH-only. Scrubbing file contents while
    // leaving the directory name in place does not clear it — that is exactly the
    // half-fix this rule exists to block.
    const dir = freshTree()
    try {
      mkdirSync(join(dir, 'archive-import'))
      writeFileSync(join(dir, 'archive-import', 'run.ts'), 'export const x = 1\n')
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_B64: DENYLIST })
      expect(out).not.toContain('[private-path]')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('commit-message + PR-body scan', () => {
  test('RED on a denylisted token in a COMMIT MESSAGE', () => {
    // GHArchive/BigQuery mirror this permanently; there is no removal path, so
    // the gate has to stop it before the push, not after.
    const { dir, base } = gitFixture([`chore: move ${PATHY}/data into place`])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
      })
      expect(out).toContain('[pii-denylist-msg]')
      expect(out).toContain('COMMIT-MESSAGE')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('RED on the private-path token in a COMMIT MESSAGE (no denylist needed)', () => {
    const { dir, base } = gitFixture([`feat: import the ${PRIVATE_TOKEN} archive`])
    try {
      const { code, out } = runGate(dir, { LEAK_GATE_BASE_SHA: base })
      expect(out).toContain('[private-path-msg]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('RED on a denylisted token in the PR TITLE or BODY', () => {
    for (const field of ['LEAK_GATE_PR_TITLE', 'LEAK_GATE_PR_BODY']) {
      const { dir, base } = gitFixture()
      try {
        const { code, out } = runGate(dir, {
          LEAK_GATE_BASE_SHA: base,
          LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
          [field]: `see ${PATHY}/README for context`,
        })
        expect(out).toContain('[pii-denylist-msg]')
        expect(out).toContain('PR-TITLE-BODY')
        expect(code).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 60_000)

  test('GREEN on clean commit messages and a clean PR body', () => {
    const { dir, base } = gitFixture(['chore: tidy the build', 'fix: correct an off-by-one'])
    try {
      const { code, out } = runGate(dir, {
        LEAK_GATE_BASE_SHA: base,
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
        LEAK_GATE_PR_BODY: 'Routine cleanup. No user-visible change.',
      })
      expect(out).toContain('message lines in scan window')
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('in CI with no resolvable commit range ⇒ exit 2, never a silent skip', () => {
    const dir = freshTree() // deliberately NOT a git repo
    try {
      const { code, out } = runGate(dir, {
        ...CANONICAL_PUSH,
        LEAK_GATE_PII_DENYLIST_B64: DENYLIST,
      })
      expect(out).toContain('FATAL')
      expect(out).toContain('fetch-depth: 0')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('allowlist audit — an exception must be narrow and live', () => {
  test('a DIRECTORY GLOB is rejected (exit 2)', () => {
    // The concrete regression: `migrations/*` exempted 120 files to cover 4, and
    // pre-exempted every migration added afterwards.
    const dir = freshTree()
    const gate = sandboxGate(dir, `src/*:${T2}-code\n`)
    try {
      const { code, out } = runGate(dir, {}, gate)
      expect(out).toContain('[allowlist-dirglob]')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a glob matching more than 3 files is rejected (exit 2)', () => {
    const dir = freshTree()
    const gate = sandboxGate(dir, `src/f?.ts:${T2}-code\n`)
    try {
      for (let i = 0; i < 4; i++) writeFileSync(join(dir, 'src', `f${i}.ts`), 'export const x = 1\n')
      const { code, out } = runGate(dir, {}, gate)
      expect(out).toContain('[allowlist-breadth]')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a STALE entry matching no file is rejected (exit 2)', () => {
    // Rot: it documents an exception that no longer exists, and silently becomes
    // wrong the day something else claims that path. One such entry was live in
    // the committed allowlist until this audit was added.
    const dir = freshTree()
    const gate = sandboxGate(dir, `src/deleted-long-ago.ts:${T2}-code\n`)
    try {
      const { code, out } = runGate(dir, {}, gate)
      expect(out).toContain('[allowlist-stale]')
      expect(code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an EXACT-path entry is accepted and still suppresses its finding', () => {
    // The other direction: the audit must not have broken the allowlist itself.
    const dir = freshTree()
    // The planted token trips two rules; exempt both, or the case proves nothing
    // about the audit and everything about `${T2}-purged`.
    const gate = sandboxGate(dir, `src/db.ts:${T2}-code\nsrc/db.ts:${T2}-purged\n`)
    try {
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      const { code, out } = runGate(dir, { LEAK_GATE_PII_DENYLIST_B64: DENYLIST }, gate)
      expect(out).not.toContain(`[${T2}-code]`)
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the COMMITTED allowlist passes its own audit', () => {
    // Runs the real gate against the real tree. Only the audit verdict is
    // asserted (the tree's own findings are a separate concern): a config error
    // exits 2 before any rule runs.
    const { code, out } = runGate(REPO_ROOT)
    expect(out).not.toContain('[allowlist-dirglob]')
    expect(out).not.toContain('[allowlist-breadth]')
    expect(out).not.toContain('[allowlist-stale]')
    expect(out).not.toContain('[allowlist-malformed]')
    expect(code).not.toBe(2)
  }, 180_000)
})
