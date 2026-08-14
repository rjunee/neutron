/**
 * THE CREDENTIAL-ARRIVAL TEST for `trident/gh-authed.ts`.
 *
 * A test that stubs a probe's RETURN VALUE proves the classifier works; it proves
 * nothing about whether the credential ever reached `gh`. So this suite runs the
 * real script as a SUBPROCESS with a stub `gh` first on PATH, against a REAL
 * temp `SecretsStore`, and reads what the child actually received:
 *
 *   • token in the store  → the child's `GH_TOKEN` is the sentinel  (goes red if
 *     the `githubProcessEnv(token)` spread is removed);
 *   • token removed       → the child's `GH_TOKEN` is ABSENT       (goes red if
 *     anyone hardcodes a token instead of reading the store);
 *   • never in argv, never in any file, and no `~/.config/gh` is created — the
 *     `gh auth login` / hosts.yml design the card explicitly refuses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { storeGitHubToken } from '@neutronai/github/credential.ts'
import { runGhAuthed } from './gh-authed.ts'

const SCRIPT = new URL('./gh-authed.ts', import.meta.url).pathname
const SENTINEL = 'ghp_TEST_SENTINEL_12345'
const OWNER = 'tester'

let workdir: string
let dataDir: string
let dbPath: string
let stubBin: string
let capture: string
let fakeHome: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-gh-authed-'))
  dataDir = join(workdir, 'project')
  stubBin = join(workdir, 'bin')
  fakeHome = join(workdir, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(stubBin, { recursive: true })
  mkdirSync(fakeHome, { recursive: true })
  dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()

  // The capture file lives OUTSIDE the temp tree the "never written to disk"
  // assertion sweeps, because it is the one place the token is deliberately
  // written — by the stub, from the env it was handed.
  capture = join(mkdtempSync(join(tmpdir(), 'neutron-gh-capture-')), 'gh.log')

  // The stub `gh`: record the env it inherited and the argv it was given.
  writeFileSync(
    join(stubBin, 'gh'),
    `#!/bin/sh\nprintf 'ENV=%s\\n' "\${GH_TOKEN:-ABSENT}" >> ${JSON.stringify(capture)}\nprintf 'ARGV=%s\\n' "$*" >> ${JSON.stringify(capture)}\nexit 0\n`,
    { mode: 0o755 },
  )
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
  rmSync(capture, { force: true })
})

/** Write the instance GitHub token into a real store, then close the writer
 *  handle so the subprocess's read-only open sees a settled file. */
async function seedToken(token: string): Promise<void> {
  const db = ProjectDb.open(dbPath)
  const store = new SecretsStore({ data_dir: dataDir, db })
  await storeGitHubToken(store, asOwnerHandle(OWNER), token)
  db.close()
}

/** Run the real script as a subprocess with the stub `gh` first on PATH and NO
 *  `GH_TOKEN` in the parent environment — the unauthenticated box the card
 *  describes. */
async function runScript(args: string[]): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') continue
    if (v !== undefined) env[k] = v
  }
  env['PATH'] = `${stubBin}:${process.env['PATH'] ?? ''}`
  env['HOME'] = fakeHome
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(child.stderr).text()
  const code = await child.exited
  return { code, stderr }
}

function captureLines(): string[] {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n') : []
}

/** Every regular file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

describe('gh-authed: the instance token reaches the gh child, from the store, per command', () => {
  test('a stored token arrives in the child ENV — and nowhere else', async () => {
    await seedToken(SENTINEL)

    const { code } = await runScript([
      '--db',
      dbPath,
      '--data-dir',
      dataDir,
      '--owner',
      OWNER,
      '--',
      'pr',
      'view',
      '1',
    ])

    expect(code).toBe(0)
    const lines = captureLines()
    // THE ASSERTION THIS FILE EXISTS FOR: the child's environment carried the
    // token that was in the store. Remove the `githubProcessEnv(token)` spread
    // and this reads ABSENT.
    expect(lines).toContain(`ENV=${SENTINEL}`)
    // ...and the argv is the probe's own command, with no secret in it (a `ps`
    // listing is a transcript).
    const argv = lines.find((l) => l.startsWith('ARGV='))
    expect(argv).toBe('ARGV=pr view 1')
    expect(argv).not.toContain(SENTINEL)

    // NEVER ON DISK. The store's own db holds ciphertext, so no file under the
    // data dir / work tree may contain the plaintext.
    for (const file of walk(workdir)) {
      expect(readFileSync(file, 'utf8').includes(SENTINEL)).toBe(false)
    }
    // NO `gh auth login`, NO hosts.yml: HOME pointed at a fresh dir and the run
    // left it exactly as empty as it found it.
    expect(readdirSync(fakeHome)).toEqual([])
  })

  test('credential REMOVED from the store → the child sees ABSENT (unconnected behaves as today)', async () => {
    // No `seedToken` at all: a migrated, keyed store with no GitHub row — the
    // instance that never connected GitHub.
    const db = ProjectDb.open(dbPath)
    const store = new SecretsStore({ data_dir: dataDir, db })
    await store.put({
      owner_handle: asOwnerHandle(OWNER),
      kind: 'byo_api_key',
      label: 'unrelated',
      plaintext: 'not-a-github-token',
    })
    db.close()

    const { code } = await runScript([
      '--db',
      dbPath,
      '--data-dir',
      dataDir,
      '--owner',
      OWNER,
      '--',
      'pr',
      'view',
      '1',
    ])

    // `gh` still ran, and still exited with ITS code — the wrapper never invents
    // a failure for a missing credential (`githubProcessEnv(null)` is `{}`).
    expect(code).toBe(0)
    expect(captureLines()).toContain('ENV=ABSENT')
  })

  test('a token stored then DELETED stops arriving — resolved per command, never cached', async () => {
    await seedToken(SENTINEL)
    const db = ProjectDb.open(dbPath)
    const row = (
      await new SecretsStore({ data_dir: dataDir, db }).list({ owner_handle: asOwnerHandle(OWNER) })
    ).find((r) => r.label === 'github')
    expect(row).toBeDefined()
    await new SecretsStore({ data_dir: dataDir, db }).delete(row!.id)
    db.close()

    const { code } = await runScript([
      '--db',
      dbPath,
      '--data-dir',
      dataDir,
      '--owner',
      OWNER,
      '--',
      'pr',
      'view',
      '1',
    ])

    expect(code).toBe(0)
    expect(captureLines()).toContain('ENV=ABSENT')
  })

  test('missing flags → exit 2 with a usage line, and `gh` is never invoked', async () => {
    await seedToken(SENTINEL)
    for (const args of [
      ['--db', dbPath, '--data-dir', dataDir, '--', 'pr', 'view', '1'], // no --owner
      ['--data-dir', dataDir, '--owner', OWNER, '--', 'pr', 'view', '1'], // no --db
      ['--db', dbPath, '--owner', OWNER, '--', 'pr', 'view', '1'], // no --data-dir
      ['--db', dbPath, '--data-dir', dataDir, '--owner', OWNER], // no `--` separator
      ['--db', dbPath, '--data-dir', dataDir, '--owner', OWNER, '--'], // no gh args
    ]) {
      const { code, stderr } = await runScript(args)
      expect(code).toBe(2)
      expect(stderr).toContain('usage: bun trident/gh-authed.ts')
      expect(existsSync(capture)).toBe(false)
    }
  })
})

describe('gh-authed: the env it builds (unit seam)', () => {
  /** Record the spawn options without running anything. */
  function recorder(): { spawn: typeof Bun.spawn; envs: Array<Record<string, string | undefined>> } {
    const envs: Array<Record<string, string | undefined>> = []
    const spawn = ((cmd: string[], opts: { env?: Record<string, string | undefined> }) => {
      envs.push(opts.env ?? {})
      return { exited: Promise.resolve(0), cmd }
    }) as unknown as typeof Bun.spawn
    return { spawn, envs }
  }

  test('with a stored token: GH_TOKEN + the github.com-scoped git credential helper', async () => {
    await seedToken(SENTINEL)
    const { spawn, envs } = recorder()
    const code = await runGhAuthed(
      ['--db', dbPath, '--data-dir', dataDir, '--owner', OWNER, '--', 'pr', 'view', '1'],
      spawn,
    )
    expect(code).toBe(0)
    expect(envs[0]!['GH_TOKEN']).toBe(SENTINEL)
    // The env-only, github.com-SCOPED helper — never a config file (credential.ts
    // option 4; options 1–3 are refused).
    expect(envs[0]!['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper')
  })

  test('with no stored token: no GH_TOKEN, no git config injection at all', async () => {
    const { spawn, envs } = recorder()
    const code = await runGhAuthed(
      ['--db', dbPath, '--data-dir', dataDir, '--owner', OWNER, '--', 'pr', 'view', '1'],
      spawn,
    )
    expect(code).toBe(0)
    expect(envs[0]!['GH_TOKEN']).toBeUndefined()
    expect(envs[0]!['GIT_CONFIG_KEY_0']).toBeUndefined()
  })

  test('the gh tail is passed VERBATIM, and the flags never leak into it', async () => {
    const seen: string[][] = []
    const spawn = ((cmd: string[]) => {
      seen.push(cmd)
      return { exited: Promise.resolve(0) }
    }) as unknown as typeof Bun.spawn
    await runGhAuthed(
      [
        '--db',
        dbPath,
        '--data-dir',
        dataDir,
        '--owner',
        OWNER,
        '--',
        'pr',
        'view',
        '261',
        '--json',
        'mergeable,statusCheckRollup',
      ],
      spawn,
    )
    expect(seen[0]).toEqual(['gh', 'pr', 'view', '261', '--json', 'mergeable,statusCheckRollup'])
  })
})
