/**
 * REAL-GIT proof that the PUBLISHER — not a test harness standing next to it — merges the
 * AS_BUILT log cleanly when a concurrent build got there first.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `scripts/git/as-built-merge-realgit.test.ts`. That file
 * proves the merge driver works through real git. It does NOT prove anything is wired: Argus
 * reverted the production line in round 1 and the whole suite stayed green, because the test drove
 * the driver itself rather than the code path that is supposed to install it. So this file calls
 * `rebaseOntoObservedBase` — the actual publish step, `trident/orchestrator.ts` — against a real
 * origin, and NOTHING here installs the merge driver. If the `ensureAsBuiltMergeDriver` call is
 * removed from the publisher, nothing installs it at all, the replay hits the same conflict it
 * always did, and the first test below fails with `TridentRebaseConflict`.
 *
 * The second test is its control: the identical scenario in a checkout that does not carry this
 * log's merge contract, which is every other repository trident builds. There the publisher must
 * leave the checkout alone and the conflict must still surface as an attention state — proof that
 * this change imposes one repository's changelog layout on no one else.
 *
 * The third is the SECURITY property: a checkout that ships a hostile `install-merge-drivers.sh` is
 * not a checkout that gets to run it. The publisher's `run_host` carries the owner's `GH_TOKEN`
 * (`open/composer.ts` → `makeLazyCredentialedHostRunner` → `github/credential.ts`
 * `githubProcessEnv`), so executing a repo-supplied script there hands an untrusted repository the
 * credential that publishes every PR.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'


import { spawnCapture } from './git-mode.ts'
import { ensureAsBuiltMergeDriver, rebaseOntoObservedBase, TridentRebaseConflict } from './orchestrator.ts'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

const HEADER = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n\n'
const HISTORY = '## 2026-08-14 — history that must survive\n\nold body\n\n'
const FIRST = '## 2026-08-16 — the build that published first\n\nbody one\n\n'
const SECOND = '## 2026-08-16 — the build that published second\n\nbody two\n\n'

interface World {
  root: string
  checkout: string
  branch: string
}

/**
 * A real origin and a real checkout where `main` has ALREADY taken one build's log entry, and a
 * branch cut before that still carries its own.
 *
 * `shipsInstaller: false` models every other repository trident builds — same conflict, no log
 * merge contract to find. `installerBody` replaces the shipped installer with something hostile,
 * committed at the base like any other file in a repo trident was pointed at.
 */
async function seedWorld(opts: { shipsInstaller: boolean; label?: string; installerBody?: string }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'as-built-wiring-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'checkout')
  const branch = `trident/as-built-${opts.label ?? (opts.shipsInstaller ? 'ships' : 'bare')}`

  const init = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!init.ok) throw new Error(`bare init failed: ${init.stderr}`)

  const made = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', checkout], root)
  if (!made.ok) throw new Error(`checkout init failed: ${made.stderr}`)
  await git(checkout, 'config', 'user.email', 'trident-test@neutron.local')
  await git(checkout, 'config', 'user.name', 'Trident Test')
  await git(checkout, 'remote', 'add', 'origin', `file://${origin}`)

  mkdirSync(join(checkout, 'docs'), { recursive: true })
  if (opts.shipsInstaller) {
    mkdirSync(join(checkout, 'scripts', 'git'), { recursive: true })
    for (const rel of [
      ['scripts', 'install-merge-drivers.sh'],
      ['scripts', 'git', 'as-built-merge-driver.ts'],
      ['scripts', 'git', 'as-built-log-merge.ts'],
    ]) {
      cpSync(join(REPO_ROOT, ...rel), join(checkout, ...rel))
    }
    if (opts.installerBody !== undefined) {
      writeFileSync(join(checkout, 'scripts', 'install-merge-drivers.sh'), opts.installerBody)
    }
  }

  writeFileSync(join(checkout, 'docs', 'AS_BUILT.md'), HEADER + HISTORY)
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(checkout, 'push', '-q', 'origin', 'main')

  // The branch, cut from that base, prepends ITS entry.
  await git(checkout, 'branch', branch, 'main')
  const tmp = join(checkout, `.build-${branch.replace(/\W/g, '_')}`)
  await git(checkout, 'worktree', 'add', '-q', tmp, branch)
  writeFileSync(join(tmp, 'docs', 'AS_BUILT.md'), HEADER + SECOND + HISTORY)
  await git(tmp, 'add', '-A')
  await git(tmp, ...GIT_ID, 'commit', '-q', '-m', 'second build')
  await git(checkout, 'worktree', 'remove', '--force', tmp)

  // Meanwhile the OTHER build merged first, so origin/main moves under this branch.
  writeFileSync(join(checkout, 'docs', 'AS_BUILT.md'), HEADER + FIRST + HISTORY)
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'first build')
  await git(checkout, 'push', '-q', 'origin', 'main')

  return { root, checkout, branch }
}

describe('the publisher replaying a branch whose log entry raced another', () => {
  test('WIRING — the publish step itself merges both entries, with nothing else installing the driver', async () => {
    const world = await seedWorld({ shipsInstaller: true })
    // The checkout is untouched: no merge driver configured by this test, by design.
    const before = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(before.stdout.trim()).toBe('')

    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-wiring')
    const res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)

    expect(res.rebased).toBe(true)

    // Both entries landed, history intact, nothing interleaved — read off the REPLAYED commit.
    const show = await spawnCapture(
      ['git', '-C', world.checkout, 'show', `${res.head}:docs/AS_BUILT.md`],
      world.checkout,
    )
    expect(show.ok).toBe(true)
    expect(show.stdout).not.toContain('<<<<<<<')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published first')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published second')
    expect(show.stdout).toContain('## 2026-08-14 — history that must survive')

    // The publisher installed the driver as part of publishing — that is the wiring under test.
    const after = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(after.stdout.trim()).not.toBe('')

    expect(existsSync(scratchDir)).toBe(false)
  }, 60_000)

  test('CONTROL — a repo that does not carry the log merge contract is left alone, and still reports the conflict', async () => {
    const world = await seedWorld({ shipsInstaller: false })
    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-bare')

    // Same race, same file, no merge contract to find: the publisher must not invent one, and the
    // conflict must surface as an attention state rather than being silently resolved.
    await expect(
      rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir),
    ).rejects.toBeInstanceOf(TridentRebaseConflict)

    const after = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(after.stdout.trim()).toBe('')
    expect(readFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), 'utf8')).not.toContain('<<<<<<<')
  }, 60_000)

  test('SECURITY — a same-named installer in the checkout is NEVER executed, and the driver named is OURS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'as-built-hostile-'))
    created.push(root)
    const canary = join(root, 'installer-ran')
    // Exactly what the old code path enabled: the publisher's `run_host` carries `GH_TOKEN`, so a
    // repo-supplied script at this path could read the owner's credential out of its own
    // environment. Writing it to a file stands in for exfiltrating it.
    const hostile = `#!/usr/bin/env bash\nprintf '%s' "\${GH_TOKEN:-no-token}" > ${JSON.stringify(canary)}\n`

    const world = await seedWorld({ shipsInstaller: true, label: 'hostile', installerBody: hostile })

    // CONTROL — prove the mutation landed. If this script is ever run with the credential in scope,
    // it writes the canary; a test asserting "no canary" is worthless without this half.
    const proof = await spawnCapture(
      ['bash', join(world.checkout, 'scripts', 'install-merge-drivers.sh')],
      world.checkout,
      { GH_TOKEN: 'sentinel-credential-value' },
    )
    expect(proof.ok).toBe(true)
    expect(readFileSync(canary, 'utf8')).toBe('sentinel-credential-value')
    rmSync(canary)
    // …and it installed nothing, so anything configured after this came from the publisher.
    const afterHostile = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(afterHostile.stdout.trim()).toBe('')

    // The publish outcome is captured rather than awaited bare, so the security assertion below is
    // reached whatever publishing does. A failing publish must not be allowed to stand in for
    // "the script was not executed" — those are different facts and only one of them is the point.
    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-hostile')
    let res: Awaited<ReturnType<typeof rebaseOntoObservedBase>> | null = null
    let publishError: unknown = null
    try {
      res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)
    } catch (err) {
      publishError = err
    }

    // THE PROPERTY: publishing did not run it.
    expect(existsSync(canary)).toBe(false)

    expect(publishError).toBeNull()
    expect(res).not.toBeNull()
    if (res === null) return

    // …and it did not merely skip the feature either — the driver is installed, and the command it
    // names is this installation's script, not anything under the checkout.
    const configured = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(configured.stdout).toContain(join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts'))
    expect(configured.stdout).not.toContain(world.checkout)
    expect(configured.stdout).not.toContain('install-merge-drivers.sh')

    const show = await spawnCapture(
      ['git', '-C', world.checkout, 'show', `${res.head}:docs/AS_BUILT.md`],
      world.checkout,
    )
    expect(show.stdout).not.toContain('<<<<<<<')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published first')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published second')
  }, 60_000)

  test('SECURITY — the credential is not in the driver\'s environment, and neither is the checkout\'s .env', async () => {
    // TWO SEPARATE HOLES, MEASURED THROUGH REAL GIT RATHER THAN REASONED ABOUT.
    //
    //   1. bun auto-loads a `.env` from its cwd — under a merge driver, the checked-out repository —
    //      and does so INDEPENDENTLY of `bunfig.toml`, so `--config=/dev/null` does not cover it.
    //   2. the driver is a child of the publisher's `run_host`, whose environment carries the
    //      owner's `GH_TOKEN` (`github/credential.ts` `githubProcessEnv`) — the credential that
    //      publishes every PR — in a process whose entire job is reading three files.
    //
    // Neither is a demonstrated exploit on its own; together they are an untrusted input and a
    // valuable secret in one process, which is the pair that only has to line up once.
    const world = await seedWorld({ shipsInstaller: true, label: 'envscope' })
    writeFileSync(join(world.checkout, '.env'), 'INJECTED_BY_CHECKOUT=yes\n')
    await git(world.checkout, 'add', '-A')
    await git(world.checkout, ...GIT_ID, 'commit', '-q', '-m', 'a repo that ships a .env, like every bun project')

    // Installed by the production path, not by a hand-written config line.
    expect(await ensureAsBuiltMergeDriver(spawnCapture, world.checkout)).toBe(true)
    const read = await spawnCapture(['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'], world.checkout)
    const configured = read.stdout.trim()
    expect(configured).toContain('--env-file=/dev/null')
    expect(configured).toContain('-u GH_TOKEN')

    // A probe standing in for the driver: the SAME command, interpreter and flags, recording the
    // environment it was actually started with. Swapping only the script is what makes the two runs
    // below differ by exactly the controls under test.
    const canary = join(world.root, 'driver-env.json')
    const probe = join(world.root, 'probe.ts')
    writeFileSync(
      probe,
      `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync(${JSON.stringify(canary)}, JSON.stringify({\n` +
        `  GH_TOKEN: process.env.GH_TOKEN ?? null,\n` +
        `  INJECTED_BY_CHECKOUT: process.env.INJECTED_BY_CHECKOUT ?? null,\n` +
        `}))\n`,
    )
    const asProbe = configured.replace(/'[^']*as-built-merge-driver\.ts'/, `'${probe}'`)
    expect(asProbe).not.toBe(configured)

    const head = (await spawnCapture(['git', '-C', world.checkout, 'rev-parse', 'HEAD'], world.checkout)).stdout.trim()
    /** Merge the racing branch, which makes git run the configured driver on the log. */
    const mergeWithDriver = async (command: string): Promise<void> => {
      await spawnCapture(['git', '-C', world.checkout, 'config', 'merge.as-built-log.driver', command], world.checkout)
      await spawnCapture(
        ['git', '-C', world.checkout, ...GIT_ID, 'merge', '--no-edit', world.branch],
        world.checkout,
        { GH_TOKEN: 'sentinel-credential-value' },
      )
      await spawnCapture(['git', '-C', world.checkout, 'reset', '-q', '--hard', head], world.checkout)
    }

    // CONTROL FIRST — the same command with the two controls removed and nothing else changed. A
    // test asserting "the token is absent" proves nothing until the token has been shown present.
    const unprotected = asProbe.replace(/^\S*env(?: -u \S+)+ /, '').replace(' --env-file=/dev/null', '')
    expect(unprotected).not.toContain('-u GH_TOKEN')
    await mergeWithDriver(unprotected)
    const leaked = JSON.parse(readFileSync(canary, 'utf8')) as Record<string, string | null>
    expect(leaked.GH_TOKEN).toBe('sentinel-credential-value')
    expect(leaked.INJECTED_BY_CHECKOUT).toBe('yes')
    rmSync(canary)

    // …and now the command the publisher actually writes.
    await mergeWithDriver(asProbe)
    const scoped = JSON.parse(readFileSync(canary, 'utf8')) as Record<string, string | null>
    expect(scoped.GH_TOKEN).toBeNull()
    expect(scoped.INJECTED_BY_CHECKOUT).toBeNull()

    // …and the real driver, with those controls in place, still merges — the isolation was not
    // bought by breaking the thing it protects.
    await spawnCapture(['git', '-C', world.checkout, 'config', 'merge.as-built-log.driver', configured], world.checkout)
    const real = await spawnCapture(
      ['git', '-C', world.checkout, ...GIT_ID, 'merge', '--no-edit', world.branch],
      world.checkout,
      { GH_TOKEN: 'sentinel-credential-value' },
    )
    expect(real.ok).toBe(true)
    const log = readFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(log).not.toContain('<<<<<<<')
    expect(log).toContain('## 2026-08-16 — the build that published first')
    expect(log).toContain('## 2026-08-16 — the build that published second')
  }, 60_000)

  test('a failed driver-config write never reaches the fatal half — there is nothing to roll back', async () => {
    // `merge.<name>.name` set with no `.driver` is the one state git refuses outright —
    // `fatal: custom merge driver as-built-log lacks command line`, exit 128, measured on git
    // 2.50.1. Round 1 wrote `.name` first and unset it by hand when `.driver` failed, i.e. it
    // repaired the fatal state with a THIRD config write that the very condition causing the
    // failure — a held `config.lock` — would also have blocked. Ordering removes the state instead:
    // `.driver` goes first, and a `run_host` that fails only on that key must therefore leave the
    // config untouched, with no `--unset` anywhere.
    const calls: string[][] = []
    const runHost = async (cmd: string[]) => {
      calls.push(cmd)
      const ok = !cmd.includes('merge.as-built-log.driver')
      return { ok, exit_code: ok ? 0 : 255, stdout: '', stderr: ok ? '' : 'could not lock config file' }
    }

    // Any checkout that satisfies the applicability gate will do; this repo is one.
    const installed = await ensureAsBuiltMergeDriver(runHost, REPO_ROOT)
    expect(installed).toBe(false)
    // The cosmetic key was never written, so no cleanup is owed for it…
    expect(calls.some((cmd) => cmd.includes('merge.as-built-log.name'))).toBe(false)
    // …and none was attempted.
    expect(calls.some((cmd) => cmd.includes('--unset'))).toBe(false)
    // …and it never went on to bind a path to the driver it could not configure.
    expect(calls.some((cmd) => cmd.includes('--git-common-dir'))).toBe(false)
  })

  test('CONTROL — the COSMETIC write failing is not fatal: the driver still installs', async () => {
    // The other half of the ordering claim. If `.name` were load-bearing this would have to fail,
    // and writing `.driver` first would be no safer than writing it second.
    const calls: string[][] = []
    const runHost = async (cmd: string[]) => {
      calls.push(cmd)
      const ok = !cmd.includes('merge.as-built-log.name')
      return { ok, exit_code: ok ? 0 : 255, stdout: '', stderr: ok ? '' : 'could not lock config file' }
    }
    // `--git-common-dir` has to answer for the attribute write to be attempted at all; point it at
    // a scratch dir so this test writes nothing into the real repo.
    const scratch = mkdtempSync(join(tmpdir(), 'as-built-cosmetic-'))
    created.push(scratch)
    const runHostWithCommonDir = async (cmd: string[]) => {
      if (cmd.includes('--git-common-dir')) return { ok: true, exit_code: 0, stdout: `${scratch}\n`, stderr: '' }
      return runHost(cmd)
    }

    const installed = await ensureAsBuiltMergeDriver(runHostWithCommonDir, REPO_ROOT)
    expect(installed).toBe(true)
    expect(readFileSync(join(scratch, 'info', 'attributes'), 'utf8')).toContain('docs/AS_BUILT.md merge=as-built-log')
    // …and the command it wrote is locked down against the checkout's own bun configuration.
    const driverWrite = calls.find((cmd) => cmd.includes('merge.as-built-log.driver'))
    expect(driverWrite).toBeDefined()
    expect(driverWrite?.at(-1)).toContain('--config=/dev/null')
  })

  test('SECURITY — a bunfig.toml in the checkout cannot preload code into the driver process', async () => {
    // The vector round 1 left open. git runs a merge driver with cwd at the top of the working tree
    // being merged, and bun reads `bunfig.toml` from cwd — so naming a trusted script is not enough
    // while the checkout still supplies the config that script starts under. The publisher's
    // `run_host` carries `GH_TOKEN`, so the preload reads the owner's credential from its own
    // environment. Reproduced on bun 1.3.9 before the flag; inert after it.
    const world = await seedWorld({ shipsInstaller: true, label: 'bunfig' })
    const canary = join(world.root, 'exfiltrated.txt')

    // The payload, committed on `main` so the scratch rebase worktree checks it out.
    writeFileSync(join(world.checkout, 'bunfig.toml'), 'preload = ["./exfil.ts"]\n')
    writeFileSync(
      join(world.checkout, 'exfil.ts'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(canary)}, String(process.env.GH_TOKEN))\n`,
    )
    await git(world.checkout, 'add', '-A')
    await git(world.checkout, ...GIT_ID, 'commit', '-q', '-m', 'a repo that ships its own bun configuration')
    await git(world.checkout, 'push', '-q', 'origin', 'main')

    // CONTROL — prove the payload is live and this scenario reaches it, by running the driver the
    // way the checkout would have it run: same interpreter, same script, cwd in the checkout, no
    // `--config`. "No canary" means nothing without a demonstrated canary.
    const control = await spawnCapture(
      [process.execPath, join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts')],
      world.checkout,
      { GH_TOKEN: 'sentinel-credential-value' },
    )
    expect(control.ok).toBe(false) // no arguments — it refuses, which is fine; the preload ran first
    expect(readFileSync(canary, 'utf8')).toBe('sentinel-credential-value')
    rmSync(canary)

    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-bunfig')
    const res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)

    // THE PROPERTY: publishing merged the log without executing anything the checkout supplied.
    expect(existsSync(canary)).toBe(false)
    expect(res.rebased).toBe(true)

    const configured = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(configured.stdout).toContain('--config=/dev/null')

    // …and it did not buy that by skipping the merge, which would be a different bug wearing the
    // same green tick.
    const show = await spawnCapture(['git', '-C', world.checkout, 'show', `${res.head}:docs/AS_BUILT.md`], world.checkout)
    expect(show.stdout).not.toContain('<<<<<<<')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published first')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published second')
  }, 60_000)
})
