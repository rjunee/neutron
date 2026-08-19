import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * `trident/codex-credential.ts` — the connect/status/disconnect service over the
 * #149 ProjectCredentialStore, plus the end-to-end VERIFY: after connect, the
 * per-project CODEX_HOME/auth.json makes `trident/codex-review.sh` see codex as
 * CONNECTED (exit 0), not the exit-10 NOT_CONNECTED branch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { codexAuthPath, readMaterializedAuth } from './codex-auth.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'
import {
  buildRunCodexHomeResolver,
  CODEX_CREDENTIAL_SERVICE,
  CodexCredentialService,
  codexCliOnPath,
  codexExecutorAvailability,
} from './codex-credential.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REVIEW_SCRIPT = join(HERE, 'codex-review.sh')
const OWNER = asOwnerHandle('owner')

let tmp: string
let db: ProjectDb
let store: ProjectCredentialStore
let codexHome: string

function subscriptionAuth(): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: 'a' },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

function newService(): CodexCredentialService {
  return new CodexCredentialService({ store, codexHome, rotation: new SqliteCodexRotationStore(db) })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-cred-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  const crypto = new SecretsStore({ data_dir: tmp, db })
  store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('CodexCredentialService', () => {
  test('connect: validates + stores encrypted + materializes to CODEX_HOME', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth())
    expect(res.ok).toBe(true)
    expect(res.status).toBe('connected')
    expect(res.mode).toBe('subscription')

    // Stored in the #149 store under service 'codex', global scope.
    const resolved = store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)
    expect(resolved).not.toBeNull()
    expect(resolved?.scope).toBe('global')
    // ...encrypted at rest (ciphertext !== plaintext).
    const row = db
      .prepare<{ ciphertext: string }, [string]>(
        `SELECT ciphertext FROM project_credentials WHERE service = ?`,
      )
      .get(CODEX_CREDENTIAL_SERVICE)
    expect(row?.ciphertext).toBeDefined()
    expect(row?.ciphertext).not.toContain('refresh')

    // Materialized to CODEX_HOME/auth.json.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  test('connect REJECTS a metered OPENAI_API_KEY — never stored, never materialized', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, 'sk-live-deadbeef0123456789')
    expect(res.ok).toBe(false)
    expect(res.code).toBe('metered_key')
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)).toBeNull()
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('status reflects connected / not_connected', async () => {
    const svc = newService()
    expect(svc.status(OWNER).status).toBe('not_connected')
    await svc.connect(OWNER, subscriptionAuth())
    const s = svc.status(OWNER)
    expect(s.status).toBe('connected')
    expect(s.materialized).toBe(true)
  })

  test('disconnect removes the credential + the auth.json', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    const { ok } = await svc.disconnect(OWNER)
    expect(ok).toBe(true)
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)).toBeNull()
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    expect(svc.status(OWNER).status).toBe('not_connected')
  })

  test('ensureMaterialized self-heals a missing auth.json from the stored credential', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    // Simulate a fresh process / wiped tmp: remove just the on-disk file.
    rmSync(codexAuthPath(codexHome))
    expect(readMaterializedAuth(codexHome)).toBeNull()
    // A NEW service instance (no in-memory state) re-materializes from the store.
    const svc2 = newService()
    expect(svc2.ensureMaterialized(OWNER)).toBe(true)
    expect(readMaterializedAuth(codexHome)).not.toBeNull()
  })

  test('ensureMaterialized is a no-op with no stored credential', () => {
    expect(newService().ensureMaterialized(OWNER)).toBe(false)
  })
})

describe('CodexCredentialService — GLOBAL default + per-project OVERRIDE', () => {
  const PID = 'proj-alpha'
  const projectHome = (): string => join(codexHome, 'projects', PID)

  test('connect defaults to GLOBAL scope', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth())
    expect(res.scope).toBe('global')
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)?.scope).toBe('global')
  })

  test('connect({scope:project}) stores an override + materializes under the project home', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(res.ok).toBe(true)
    expect(res.scope).toBe('project')
    // Override auth.json lands in the nested project home, NOT the global home.
    expect(existsSync(codexAuthPath(projectHome()))).toBe(true)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    // Stored at project scope under the REAL project id.
    expect(store.resolve(OWNER, PID, CODEX_CREDENTIAL_SERVICE)?.scope).toBe('project')
  })

  test('status resolves project → global; scope names the source', async () => {
    const svc = newService()
    // Only global connected → a project query resolves the global default.
    await svc.connect(OWNER, subscriptionAuth())
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('global')
    // Add an override → the project query now resolves the override.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('project')
    // A DIFFERENT project (no override) still resolves the global default.
    expect(svc.status(OWNER, { project_id: 'other' }).scope).toBe('global')
    // The global status is unaffected by the override.
    expect(svc.status(OWNER).scope).toBe('global')
  })

  test('resolveActiveCodexHome: override → global → unset', async () => {
    const svc = newService()
    // Unset → null.
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBeNull()
    // Global only → the global home for any project.
    await svc.connect(OWNER, subscriptionAuth())
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBe(codexHome)
    expect(svc.resolveActiveCodexHome(OWNER)).toBe(codexHome)
    // Override → the project home for THAT project (others still global).
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBe(projectHome())
    expect(svc.resolveActiveCodexHome(OWNER, 'other')).toBe(codexHome)
  })

  test('resolveActiveCodexHome self-heals a wiped override auth.json', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    rmSync(codexAuthPath(projectHome()))
    expect(readMaterializedAuth(projectHome())).toBeNull()
    // A fresh service re-materializes the override from the store on resolve.
    const svc2 = newService()
    expect(svc2.resolveActiveCodexHome(OWNER, PID)).toBe(projectHome())
    expect(readMaterializedAuth(projectHome())).not.toBeNull()
  })

  test('disconnect override leaves the global default intact', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    const { ok } = await svc.disconnect(OWNER, { scope: 'project', project_id: PID })
    expect(ok).toBe(true)
    expect(existsSync(codexAuthPath(projectHome()))).toBe(false)
    // Global default survives → the project falls back to it.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('global')
  })

  // ── THE 2026-08-13 OUTAGE, at the seam the composer actually wires ─────────
  // Every case above passes OWNER by hand, so it cannot catch the production
  // defect: the wiring passed the RUN'S PROJECT SLUG where the owner handle
  // belongs. These exercise `buildRunCodexHomeResolver` — the exported factory
  // `open/composer.ts` now calls — with an owner and a project that are
  // DELIBERATELY DIFFERENT STRINGS, because when they are equal the bug is
  // invisible.
  test('the run resolver asks by OWNER handle, with the run project as the override key', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    const resolve = buildRunCodexHomeResolver(svc, OWNER)
    // A run in a project with NO override resolves the owner's GLOBAL default.
    // Pre-fix this returned null and the build died with CODEX_HOME unset.
    expect(resolve({ project_slug: 'a-project-that-is-not-the-owner' })).toBe(codexHome)
    // An override for THAT project wins; other projects still resolve global.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(resolve({ project_slug: PID })).toBe(projectHome())
    expect(resolve({ project_slug: 'other' })).toBe(codexHome)
  })

  test('the defect itself: asking by the run project slug resolves NOTHING', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    // What the wiring used to do — `resolveActiveCodexHome(asOwnerHandle(run.project_slug))`.
    // The credential is stored against the owner, so this matches no row and a
    // CONNECTED, MATERIALIZED credential reads as "not connected". Kept as an
    // executable record of the failure: if this ever starts returning a home,
    // the lookup key has changed meaning and the fix above needs revisiting.
    expect(svc.resolveActiveCodexHome(asOwnerHandle('a-project-that-is-not-the-owner'))).toBeNull()
    // And the credential really is there — it is only the NAME that was wrong.
    expect(svc.resolveActiveCodexHome(OWNER)).toBe(codexHome)
  })

  test('ensureMaterialized ignores a project override (global-only self-heal)', async () => {
    const svc = newService()
    // Only a project override exists — no global default.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    // ensureMaterialized must NOT pull the override into the global home.
    expect(newService().ensureMaterialized(OWNER)).toBe(false)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('status reports override_present so the UI can always remove a stale override', async () => {
    const svc = newService()
    // No override → false on a project query; the GLOBAL status never carries it.
    expect(svc.status(OWNER, { project_id: PID }).override_present).toBe(false)
    expect(svc.status(OWNER).override_present).toBeUndefined()
    // A live override → present + scope project.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    const live = svc.status(OWNER, { project_id: PID })
    expect(live.override_present).toBe(true)
    expect(live.scope).toBe('project')
    // Removing it → false again.
    await svc.disconnect(OWNER, { scope: 'project', project_id: PID })
    expect(svc.status(OWNER, { project_id: PID }).override_present).toBe(false)
  })

  test('an EXPIRED override masks itself behind global, but override_present stays true (P2)', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth()) // working global default
    // Store an EXPIRED project override directly (expires_at in the past) — the
    // resolver skips it, so status resolves the global default (scope=global)…
    await store.set(OWNER, {
      service: CODEX_CREDENTIAL_SERVICE,
      plaintext: subscriptionAuth(),
      scope: 'project',
      project_id: PID,
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    const s = svc.status(OWNER, { project_id: PID })
    expect(s.status).toBe('connected')
    expect(s.scope).toBe('global')
    // …but the stale override ROW is still flagged, so the UI can remove it.
    expect(s.override_present).toBe(true)
  })
})

describe('connect → codex-review.sh sees CONNECTED (exit 0)', () => {
  test('after connect, a mock codex on PATH resolves the exit-0 path', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())

    // Mock codex: `login status` → exit 0 (authed); `exec -` → a real review body.
    const bin = join(tmp, 'bin')
    mkdirSync(bin, { recursive: true })
    const mock = join(bin, 'codex')
    writeFileSync(mock, '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\necho "mock codex review body"\necho "VERDICT: APPROVE"\nexit 0\n')
    chmodSync(mock, 0o755)
    const diffFile = join(tmp, 'forge.diff')
    writeFileSync(diffFile, 'diff --git a/x b/x\n+change\n')

    const res = spawnSync('bash', [REVIEW_SCRIPT, 'main'], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        CODEX_HOME: codexHome,
        NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
        NEUTRON_CODEX_DIFF_FILE: diffFile,
      },
    })
    // exit 0 = CONNECTED (NOT the exit-10 no-auth.json branch).
    expect(res.status).toBe(0)
  })

  test('with NO credential connected, codex-review.sh is exit 10 (not connected)', () => {
    // Empty CODEX_HOME (no auth.json) → the graceful NOT_CONNECTED branch.
    mkdirSync(codexHome, { recursive: true })
    const bin = join(tmp, 'bin2')
    mkdirSync(bin, { recursive: true })
    const res = spawnSync('bash', [REVIEW_SCRIPT, 'main'], {
      cwd: tmp,
      encoding: 'utf8',
      env: { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, CODEX_HOME: codexHome },
    })
    expect(res.status).toBe(10)
  })
})

describe('codexCliOnPath — the OTHER half of "can this install run codex"', () => {
  // A credential is not enough. `trident/codex-build.sh` exits 10 with no credential
  // and 11 with no CLI, and downstream the two are the same thing: a build that never
  // happened. A pane that greyed on the credential alone would offer a codex tier on
  // a box where `codex` was never installed.
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-cli-probe-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const bin = (name: string, mode: number): string => {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(d, 'codex'), mode)
    return d
  }

  test('finds an executable `codex` anywhere on PATH', () => {
    const d = bin('real', 0o755)
    // Behind an entry that does NOT have it, so the scan is proved to continue.
    expect(codexCliOnPath({ PATH: `${join(dir, 'empty')}${delimiter}${d}` })).toBe(true)
  })

  test('a NON-EXECUTABLE file called codex is not a CLI', () => {
    // `execvp` skips it, so reporting the tier available would offer a build that
    // fails at launch — the exact failure this probe exists to pre-empt.
    expect(codexCliOnPath({ PATH: bin('notexec', 0o644) })).toBe(false)
  })

  test('a DIRECTORY named codex is not a CLI, however searchable it is', () => {
    // The subtle one. `X_OK` on a directory means "searchable", which every normal
    // directory is — so a PATH entry holding a `codex/` subdirectory (a checkout, a
    // cache) passed an access-only check and un-greyed every codex tier on a box with
    // no CLI at all. `execvp` returns EACCES on a directory; so does this now.
    const d = join(dir, 'dirnamed')
    mkdirSync(join(d, 'codex'), { recursive: true })
    expect(codexCliOnPath({ PATH: d })).toBe(false)
    // POSITIVE CONTROL on the same PATH shape: the probe must still say yes when a
    // real binary follows, or the assertion above would pass for the wrong reason.
    expect(codexCliOnPath({ PATH: `${d}${delimiter}${bin('afterdir', 0o755)}` })).toBe(true)
  })

  test('a SYMLINK to a real binary still counts', () => {
    // `statSync` follows links, deliberately: a package manager that installs
    // `~/.local/bin/codex` as a symlink has installed the CLI.
    const target = join(bin('linktarget', 0o755), 'codex')
    const d = join(dir, 'linked')
    mkdirSync(d, { recursive: true })
    symlinkSync(target, join(d, 'codex'))
    expect(codexCliOnPath({ PATH: d })).toBe(true)
  })

  test('an absent, empty or unset PATH answers false rather than throwing', () => {
    mkdirSync(join(dir, 'bare'), { recursive: true })
    expect(codexCliOnPath({ PATH: join(dir, 'bare') })).toBe(false)
    expect(codexCliOnPath({ PATH: '' })).toBe(false)
    expect(codexCliOnPath({})).toBe(false)
    // An unreadable/nonexistent entry must not decide the answer for the ones after
    // it — the positive control is the same PATH with a real directory appended.
    const missing = join(dir, 'does-not-exist')
    expect(codexCliOnPath({ PATH: missing })).toBe(false)
    expect(codexCliOnPath({ PATH: `${missing}${delimiter}${bin('after', 0o755)}` })).toBe(true)
  })
})

describe('codexExecutorAvailability — the answer the settings pane shows, and WHY', () => {
  // THE DEFECT. This gate grew from one precondition to three — a credential (the
  // wrapper exits 10), the `codex` CLI (exit 11), and `perl` (exit 3,
  // `CODEX_BUILD_NO_PERL`; every network call in `trident/codex-build.sh` is bounded
  // with `perl -e alarm`, and the `-slim`/Alpine images ship none) — while the
  // owner-facing string stayed "needs a Codex connection". So a box with a healthy
  // login and no CLI sent the owner to a `codex login` that changed nothing, and a
  // perl-less box advertised a tier that dies deterministically at dispatch.
  //
  // DRIVEN WITH A REAL PATH, not asserted as a source substring: the composer's own
  // wiring is pinned separately (`gateway/__tests__/trident-phase-models-producer`),
  // and this is where the decision itself is observed.
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-availability-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A PATH directory holding executables with these names, and nothing else. */
  const pathWith = (...names: string[]): string => {
    const d = join(dir, names.join('-') || 'none')
    mkdirSync(d, { recursive: true })
    for (const n of names) {
      writeFileSync(join(d, n), '#!/bin/sh\nexit 0\n')
      chmodSync(join(d, n), 0o755)
    }
    return d
  }
  const HOME = '/somewhere/codex-home'

  test('all three present → usable, with no reason to show', () => {
    // THE POSITIVE CONTROL for the three negatives below: on the same PATH shape, a
    // box that has everything must come back usable, or each "unavailable" below
    // could be passing for a reason that has nothing to do with what it names.
    expect(
      codexExecutorAvailability({ codexHome: HOME, env: { PATH: pathWith('codex', 'perl') } }),
    ).toEqual({ usable: true })
  })

  test('no credential → the reason names the connection, and nothing else', () => {
    expect(
      codexExecutorAvailability({ codexHome: null, env: { PATH: pathWith('codex', 'perl') } }),
    ).toEqual({ usable: false, reason: 'needs a Codex connection' })
  })

  test('credential but no `codex` CLI → the reason names the CLI, NOT the login', () => {
    const answer = codexExecutorAvailability({ codexHome: HOME, env: { PATH: pathWith('perl') } })
    expect(answer).toEqual({
      usable: false,
      reason: 'needs the Codex CLI installed on this machine',
    })
    // The whole point: the owner must not be sent to re-run a login that is fine.
    expect(answer).not.toMatchObject({ reason: 'needs a Codex connection' })
  })

  test('credential and CLI but no `perl` → the reason names perl', () => {
    // The wrapper refuses BEFORE it spends a token here, so this tier was previously
    // offered as available and then died at dispatch on every alpine/debian-slim host.
    expect(
      codexExecutorAvailability({ codexHome: HOME, env: { PATH: pathWith('codex') } }),
    ).toEqual({ usable: false, reason: 'needs perl installed on this machine' })
  })

  test('an unavailable answer ALWAYS carries a non-empty reason', () => {
    // The shape is what enforces this — `{ usable: false }` does not typecheck without
    // one — but the pane renders the string, so an empty one would be a greyed row
    // with no explanation, which is the state this whole check exists to end.
    for (const env of [{ PATH: pathWith() }, { PATH: '' }, {}]) {
      const answer = codexExecutorAvailability({ codexHome: HOME, env })
      expect(answer.usable).toBe(false)
      expect(answer.usable === false && answer.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('one ChatGPT account cannot occupy two seats', () => {
  /** A bundle for a NAMED ChatGPT account, so two pastes can be same-or-different. */
  function authFor(accountId: string): string {
    return JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: accountId },
      last_refresh: '2026-06-30T00:00:00.000Z',
    })
  }

  test('REFUSES a second seat holding an account another seat already has', async () => {
    // Both clients tell the owner to run `codex login` on any machine and paste that
    // account's auth.json. Pasting his laptop's file and then his desktop's is the
    // DOCUMENTED path and lands one account in two seats — and because the CLI
    // rotates refresh tokens, the first refresh in each revokes the other. Both die,
    // each is cooled `unauthorized` (the state that never expires on a timer), and
    // cross-model review is silently gone. That is ISSUES #573 through the UI.
    const svc = newService()
    const first = await svc.connectAccount(OWNER, authFor('acct-1'))
    expect(first.ok).toBe(true)

    const dup = await svc.connectAccount(OWNER, authFor('acct-1'), { slot: 'work' })
    expect(dup.ok).toBe(false)
    expect(dup.code).toBe('duplicate_account')
    // It must NAME the seat, because "already connected" without saying where leaves
    // the owner unable to act.
    expect(dup.error ?? '').toContain('default')

    // And nothing was written: the refusal has to happen BEFORE the second bundle
    // reaches disk, since afterwards neither seat can tell which was the interloper.
    expect(svc.listAccounts(OWNER).some((a) => a.slot === 'work')).toBe(false)
  })

  test('sees a LEGACY seat that has never been through rotation', async () => {
    // A rotation row is not proof a seat exists, and its absence is not proof one
    // does not. On an upgraded install the legacy `codex` credential predates
    // rotation entirely, so `rotation.listSlots()` answers EMPTY while the
    // credential is real and in use. A guard scanning that store would find
    // nothing and admit the same account under a named seat — creating exactly the
    // mutually-revoking pair it exists to prevent.
    const svc = newService()
    // `connect` is the LEGACY path: it writes the `codex` credential row WITHOUT
    // any rotation bookkeeping, which is the pre-rotation install's state.
    expect((await svc.connect(OWNER, authFor('acct-legacy'))).ok).toBe(true)

    const dup = await svc.connectAccount(OWNER, authFor('acct-legacy'), { slot: 'work' })
    expect(dup.ok).toBe(false)
    expect(dup.code).toBe('duplicate_account')
  })

  test('ALLOWS a genuinely different account, which is the whole point of seats', async () => {
    // The control that makes the refusal meaningful: if this also failed, the guard
    // would be "no second seat, ever" rather than "no DUPLICATE second seat".
    const svc = newService()
    expect((await svc.connectAccount(OWNER, authFor('acct-1'))).ok).toBe(true)
    const second = await svc.connectAccount(OWNER, authFor('acct-2'), { slot: 'work' })
    expect(second.ok).toBe(true)
    expect(svc.listAccounts(OWNER).some((a) => a.slot === 'work')).toBe(true)
  })

  test('ALLOWS reconnecting the same account into its OWN seat — the repair path', async () => {
    // A seat whose token was revoked is fixed by pasting a fresh bundle for the SAME
    // account back into the SAME seat. Refusing that would make the guard block the
    // recovery it exists to protect.
    const svc = newService()
    expect((await svc.connectAccount(OWNER, authFor('acct-1'), { slot: 'work' })).ok).toBe(true)
    const again = await svc.connectAccount(OWNER, authFor('acct-1'), { slot: 'work' })
    expect(again.ok).toBe(true)
  })
})
