/**
 * ISSUES #316 — a re-run of `install.sh` over an existing checkout must not
 * silently install from the WRONG SOURCE.
 *
 * `install.sh` used to `git pull --ff-only` an existing `~/neutron/core`
 * against whatever origin that checkout happened to carry. Ryan hit it on
 * 2026-06-20: an earlier test install had cloned from a LOCAL path, so the
 * canonical `curl https://neutronagent.ai/install.sh | sh` "succeeded" while
 * pulling local code and never touching the public repo. Nothing in the output
 * said so — the failure is silent by construction.
 *
 * The guard aborts rather than re-pointing, because repairing in place would
 * mean `remote set-url` + `fetch` + `reset --hard`, and an install script must
 * not destroy a user's working tree to fix its own assumption.
 *
 * HALF THE VALUE HERE IS THE FALSE-POSITIVE COVERAGE. A guard that blocks
 * `git@github.com:rjunee/neutron.git` because it was expecting
 * `https://github.com/rjunee/neutron` would break people who did nothing
 * wrong, which is worse than the bug it fixes. Those cases are asserted
 * explicitly below.
 *
 * Drives the real `assert_clone_origin` via the `NEUTRON_INSTALL_CHECK_ORIGIN`
 * seam — the same isolation pattern as `install-env-perms.test.ts` — so the
 * shipped function is what runs, not a reimplementation of it.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = join(HERE, '..', '..', 'install.sh')
const PUBLIC_REPO = 'https://github.com/rjunee/neutron.git'

/** A real git repo whose `origin` is set to `originUrl`. */
function checkoutWithOrigin(originUrl: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-316-'))
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q')
  if (originUrl !== null) git('remote', 'add', 'origin', originUrl)
  return dir
}

function runGuard(dir: string, wantRepo = PUBLIC_REPO): { code: number; out: string } {
  const r = spawnSync('sh', [INSTALL_SH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NEUTRON_INSTALL_CHECK_ORIGIN: dir,
      NEUTRON_REPO: wantRepo,
    },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

describe('install.sh clone-origin guard (#316)', () => {
  test('the exact bug: a LOCAL-path origin aborts instead of being pulled', () => {
    // Ryan's actual state — `~/neutron/core` cloned from a local repo.
    const dir = checkoutWithOrigin('/Users/someone/repos/neutron-open')
    try {
      const { code, out } = runGuard(dir)
      expect(code).toBe(1)
      // The message must name BOTH urls; "wrong origin" alone is not actionable.
      expect(out).toContain('/Users/someone/repos/neutron-open')
      expect(out).toContain(PUBLIC_REPO)
      // ...and tell the user how to get out of it.
      expect(out).toContain('rm -rf')
      expect(out).toContain('NEUTRON_REPO=')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a DIFFERENT github repo (someone's fork) also aborts", () => {
    const dir = checkoutWithOrigin('https://github.com/someone-else/neutron.git')
    try {
      expect(runGuard(dir).code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a checkout with NO origin remote aborts with its own message', () => {
    // `git remote get-url` fails here; an empty result must not compare equal
    // to anything or the guard would pass on a checkout it cannot update.
    const dir = checkoutWithOrigin(null)
    try {
      const { code, out } = runGuard(dir)
      expect(code).toBe(1)
      expect(out).toContain("no 'origin' remote")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the matching origin passes — the common re-run is untouched', () => {
    const dir = checkoutWithOrigin(PUBLIC_REPO)
    try {
      const { code, out } = runGuard(dir)
      expect(code).toBe(0)
      expect(out).toContain(`origin_ok=${dir}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // These are the false positives that would break innocent users. Each is a
  // different spelling of the SAME repo and must be accepted.
  const equivalent: Array<[string, string]> = [
    ['no .git suffix', 'https://github.com/rjunee/neutron'],
    ['ssh scp-style', 'git@github.com:rjunee/neutron.git'],
    ['ssh:// url', 'ssh://git@github.com/rjunee/neutron.git'],
    ['trailing slash', 'https://github.com/rjunee/neutron/'],
    ['mixed case host', 'https://GitHub.com/rjunee/neutron.git'],
  ]
  for (const [label, url] of equivalent) {
    test(`equivalent spelling passes — ${label}`, () => {
      const dir = checkoutWithOrigin(url)
      try {
        expect(runGuard(dir).code).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('the guard is actually WIRED — it runs BEFORE the pull, not just defined', async () => {
    // Every test above drives `assert_clone_origin` through the seam, so all of
    // them stay green if the CALL is deleted from the clone block — the guard
    // would exist, be tested, and never run. That is the recurring defect this
    // repo keeps hitting ("built but never wired"), and the seam makes this
    // suite structurally vulnerable to it, so the wiring gets its own check.
    //
    // Asserting on the script text is blunt. Booting the real remote-clone path
    // would mean a network clone inside a unit test, which is worse.
    const src = await Bun.file(INSTALL_SH).text()
    const guardAt = src.indexOf('assert_clone_origin "$CLONE_DIR" "$NEUTRON_REPO"')
    const pullAt = src.indexOf('git -C "$CLONE_DIR" pull --ff-only')
    expect(guardAt).toBeGreaterThan(-1)
    expect(pullAt).toBeGreaterThan(-1)
    // Order matters: checking after the pull would report the wrong source only
    // once the wrong code was already on disk.
    expect(guardAt).toBeLessThan(pullAt)
  })

  test('NEUTRON_REPO is honoured — a deliberate fork install is not blocked', () => {
    // The escape hatch the error message advertises has to actually work,
    // otherwise the guard is a dead end for anyone installing from a fork.
    const fork = 'https://github.com/someone-else/neutron.git'
    const dir = checkoutWithOrigin(fork)
    try {
      expect(runGuard(dir, fork).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
