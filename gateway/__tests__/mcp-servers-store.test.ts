/**
 * NOTHING RUNS UNTIL THE OWNER SAYS SO, AND ONLY WHAT HE SAID YES TO.
 *
 * `OwnerMcpServerStore` joins three stores — the installed list, the encrypted env
 * values, and the durable `tool_approvals` grants — and `resolveApproved()` is the one
 * function the spawn path calls. Everything that matters about this feature's security
 * is a property of that function, so it is tested against REAL stores over a REAL
 * migrated database rather than mocks: the join is the thing that can be wrong.
 *
 * THE FOUR PROPERTIES, one describe block each:
 *   1. an UNAPPROVED server is not returned, however it got that way,
 *   2. an APPROVED server is returned, with its decrypted values,
 *   3. EDITING the command drops the approval — the program cannot widen itself,
 *   4. no response, and no stored metadata row, ever carries a VALUE.
 *
 * Each is written so that removing the guard makes it fail. `bun test` proves they
 * pass; the mutation log in `docs/as-built/2026-08-09-installable-mcp-servers.md`
 * records that each was also confirmed to FAIL against a deliberately broken guard.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import {
  MAX_TOKEN_LEN as CREDENTIAL_TOKEN_MAX,
  ProjectCredentialStore,
} from '@neutronai/project-credentials/store.ts'
import {
  MCP_SERVER_ENV_TOTAL_MAX,
  MCP_SERVER_ENV_VALUE_MAX,
} from '@neutronai/runtime/mcp-servers.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import { readOwnerMcpServers } from '@neutronai/gateway/storage/owner-metadata.ts'
import {
  OwnerMcpServerStore,
  mcpServerApprovalToolName,
} from '@neutronai/gateway/mcp-servers/store.ts'

const SLUG = 'owner'
const SECRET = 'sk-not-a-real-key'

const DRAFT = {
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio'],
  env: { EXAMPLE_API_KEY: SECRET },
}

let tmp: string
let db: ProjectDb
let approvals: ApprovalManager
let store: OwnerMcpServerStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-store-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const credentials = new ProjectCredentialStore(db, {
    crypto: new SecretsStore({ data_dir: tmp, db }),
  })
  // A notifier that does nothing: the DURABLE ROW is the state this feature reads,
  // and the settings surface is the delivery channel, so no notification is involved.
  approvals = new ApprovalManager(db, { notify: async () => {} })
  store = new OwnerMcpServerStore({
    db,
    project_slug: SLUG,
    credentials,
    owner_slug: asOwnerHandle(SLUG),
    approvals: () => approvals,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** The `grant_hash` of the spec CURRENTLY installed under `name` — what a client
 *  reads off the row it rendered, and must echo back on a decision. */
async function liveHash(name: string): Promise<string> {
  const row = (await store.list()).find((r) => r.name === name)
  expect(row).toBeDefined()
  return row!.grant_hash
}

/** Approve the spec currently installed under `name`, the way a client does. */
async function approve(name: string): Promise<void> {
  const result = await store.decide(name, 'approve', await liveHash(name))
  expect(result.ok).toBe(true)
}

describe('an UNAPPROVED server is never wired', () => {
  test('installing alone does not approve — the whole security model in one assertion', async () => {
    const result = await store.install(DRAFT)
    expect(result.ok).toBe(true)
    // It is installed and visible…
    expect((await store.list()).map((s) => s.name)).toEqual(['example-server'])
    // …and pending, and NOT resolved for the spawn.
    expect((await store.list())[0]!.approval).toBe('pending')
    expect(await store.resolveApproved()).toEqual([])
  })

  test('a DENIED server is not wired, and stays in the list so it can be fixed', async () => {
    await store.install(DRAFT)
    expect((await store.decide('example-server', 'deny', await liveHash('example-server'))).ok).toBe(
      true,
    )
    expect(await store.resolveApproved()).toEqual([])
    const rows = await store.list()
    // Deleting the owner's typed-in command because he said "not now" would make him
    // retype it; `remove()` is the uninstall.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.approval).toBe('denied')
  })

  test('with NO approval manager nothing can be approved, and nothing is wired', async () => {
    // Fail-closed on the boot-ordering case: a store whose late-bound manager never
    // arrived must not become a store that skips the gate.
    const bare = new OwnerMcpServerStore({
      db,
      project_slug: SLUG,
      credentials: new ProjectCredentialStore(db, {
        crypto: new SecretsStore({ data_dir: tmp, db }),
      }),
      owner_slug: asOwnerHandle(SLUG),
      approvals: () => null,
    })
    await bare.install(DRAFT)
    expect((await bare.list())[0]!.approval).toBe('unapproved')
    expect(await bare.resolveApproved()).toEqual([])
    // No hash is readable either (the row has one, but nothing can be approved), so the
    // refusal is proven with the hash the OTHER store computes for the same spec.
    const hash = (await bare.list())[0]!.grant_hash
    expect((await bare.decide('example-server', 'approve', hash)).ok).toBe(false)
  })

  test('approval cannot be minted by writing a row for a DIFFERENT hash', async () => {
    await store.install(DRAFT)
    // An approved row that does not carry THIS spec's grant hash is not a match. This
    // is what makes the check a hash MATCH rather than "the newest row wins".
    const id = crypto.randomUUID()
    // Not awaited: a `prompt-user` request resolves only when the owner decides, so
    // awaiting it here would hang forever. The INSERT happens before it returns.
    void approvals.requestApproval({
      id,
      project_slug: SLUG,
      topic_id: null,
      tool_name: mcpServerApprovalToolName('example-server'),
      policy: 'prompt-user',
      args: { grant_hash: 'not-the-right-hash' },
    })
    await approvals.respondApproval(id, 'approved', SLUG)
    expect(await store.resolveApproved()).toEqual([])
  })

  test('a REMOVED server is not wired', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
    expect((await store.remove('example-server')).removed).toBe(true)
    expect(await store.resolveApproved()).toEqual([])
  })

  test('UNINSTALLING REVOKES THE GRANT — reinstalling the identical spec asks again', async () => {
    // The hole this closes: `approvalStateFor` matches on the grant hash alone, so an
    // approved row that outlived the uninstall re-matched a byte-identical reinstall and
    // the server came back WIRED, never shown to the owner a second time. He removed it;
    // that has to mean something.
    await store.install(DRAFT)
    await approve('example-server')
    await store.remove('example-server')
    // The row survives as history, no longer as a grant.
    expect(approvals.findApproved(SLUG, mcpServerApprovalToolName('example-server'))).toHaveLength(0)
    expect(
      approvals.findByToolName(SLUG, mcpServerApprovalToolName('example-server')).length,
    ).toBeGreaterThan(0)

    await store.install(DRAFT)
    expect((await store.list())[0]!.approval).toBe('pending')
    expect(await store.resolveApproved()).toEqual([])
    // …and it becomes usable only after he answers again.
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
  })
})

describe('an APPROVED server IS wired, with its values', () => {
  test('resolveApproved returns the spec plus the decrypted env', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    const resolved = await store.resolveApproved()
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.command).toBe('/usr/local/bin/example-mcp')
    expect(resolved[0]!.args).toEqual(['--stdio'])
    expect(resolved[0]!.env).toEqual({ EXAMPLE_API_KEY: SECRET })
    expect((await store.list())[0]!.active).toBe(true)
  })

  test('a value ROTATION reaches the spawn without a re-approval', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    // Same program, same variables — a new token. Re-asking here would train the
    // owner to click through prompts.
    const again = await store.install({ ...DRAFT, env: { EXAMPLE_API_KEY: 'sk-rotated' } })
    expect(again.ok).toBe(true)
    expect((await store.list())[0]!.approval).toBe('approved')
    expect((await store.resolveApproved())[0]!.env).toEqual({ EXAMPLE_API_KEY: 'sk-rotated' })
  })

  test('a server with NO variables needs no secret row to be usable', async () => {
    await store.install({ name: 'bare', command: 'example-mcp' })
    await approve('bare')
    const resolved = await store.resolveApproved()
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.env).toEqual({})
  })

  test('an approved server whose SECRET vanished is NOT started', async () => {
    // Starting the program with the variable unset is not what the owner approved,
    // and would be indistinguishable from the server misbehaving.
    await store.install(DRAFT)
    await approve('example-server')
    const credentials = new ProjectCredentialStore(db, {
      crypto: new SecretsStore({ data_dir: tmp, db }),
    })
    await credentials.delete(asOwnerHandle(SLUG), '', 'mcp_env.example-server')
    expect(await store.resolveApproved()).toEqual([])
    const row = (await store.list())[0]!
    // Reported honestly: approved, but not running.
    expect(row.approval).toBe('approved')
    expect(row.secrets_present).toBe(false)
    expect(row.active).toBe(false)
  })

  test('only the DECLARED names are forwarded — a stale stored key is dropped', async () => {
    await store.install({ ...DRAFT, env: { EXAMPLE_API_KEY: SECRET, OLD_TOKEN: 'stale' } })
    await approve('example-server')
    // The owner removes one variable and re-approves the narrower grant.
    await store.install(DRAFT)
    await approve('example-server')
    expect((await store.resolveApproved())[0]!.env).toEqual({ EXAMPLE_API_KEY: SECRET })
  })
})

describe('EDITING requires re-approval — a server cannot widen itself', () => {
  test('a changed COMMAND drops the grant and re-asks', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
    await store.install({ ...DRAFT, command: '/usr/local/bin/other-mcp' })
    expect((await store.list())[0]!.approval).toBe('pending')
    expect(await store.resolveApproved()).toEqual([])
  })

  test('a changed ARG and an added env NAME each drop the grant too', async () => {
    // A DISTINCT name per case, because an approved grant for a given hash is durable:
    // reusing one name would let the previous case's approval match the re-installed
    // baseline (the intended exact-revert behaviour, pinned separately below) and the
    // second iteration would be testing nothing.
    const cases = [
      { name: 'arg-change', edit: (d: typeof DRAFT) => ({ ...d, args: ['--http'] }) },
      {
        name: 'env-widened',
        edit: (d: typeof DRAFT) => ({ ...d, env: { ...d.env, EXTRA_TOKEN: 'x' } }),
      },
    ]
    for (const c of cases) {
      const base = { ...DRAFT, name: c.name }
      await store.install(base)
      await approve(c.name)
      expect((await store.resolveApproved()).some((s) => s.name === c.name)).toBe(true)
      await store.install(c.edit(base))
      expect((await store.resolveApproved()).some((s) => s.name === c.name)).toBe(false)
    }
  })

  test('a decision carrying a STALE hash is refused — the press was about another command', async () => {
    // The owner reads a prompt on one device, the spec is edited from another, then he
    // presses Approve on the screen he still has. Applying that press to the new command
    // is precisely what the hash prevents — and before the decision carried a hash, that
    // is exactly what happened: the store bound the press to whatever was current.
    await store.install(DRAFT)
    const staleHash = await liveHash('example-server')
    await store.install({ ...DRAFT, command: '/usr/local/bin/other-mcp' })

    const refused = await store.decide('example-server', 'approve', staleHash)
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('older version')
    // NOTHING was approved. The new command did not inherit the press…
    expect(await store.resolveApproved()).toEqual([])
    // …and the refusal handed back the list carrying the prompt he now has to read.
    expect(refused.servers[0]!.approval).toBe('pending')
    expect(refused.servers[0]!.command).toBe('/usr/local/bin/other-mcp')

    // Answering the CURRENT prompt works, and wires the command that prompt described.
    await approve('example-server')
    expect((await store.resolveApproved())[0]!.command).toBe('/usr/local/bin/other-mcp')
  })

  test('a decision with NO hash at all is refused', async () => {
    // A client that forgot the field must not fall back to "whatever is installed".
    await store.install(DRAFT)
    expect((await store.decide('example-server', 'approve', undefined)).ok).toBe(false)
    expect(await store.resolveApproved()).toEqual([])
  })

  test('DENY then APPROVE takes one press, not two', async () => {
    // The denied row fails the pending+hash match, so this used to mint a fresh request,
    // answer `ok:false`, surface a 409 — and need an unexplained second press. Safe to
    // apply directly BECAUSE the hash matched: the press is provably about the spec that
    // was on screen.
    await store.install(DRAFT)
    const hash = await liveHash('example-server')
    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)
    expect((await store.list())[0]!.approval).toBe('denied')

    const approved = await store.decide('example-server', 'approve', hash)
    expect(approved.ok).toBe(true)
    expect(approved.servers[0]!.approval).toBe('approved')
    expect(await store.resolveApproved()).toHaveLength(1)
  })

  test('denying an ALREADY-denied spec is idempotent too', async () => {
    await store.install(DRAFT)
    const hash = await liveHash('example-server')
    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)
    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)
    expect(await store.resolveApproved()).toEqual([])
  })

  test('approving an ALREADY-approved spec is idempotent, not an error', async () => {
    // A double-tap, or two clients open on the same row, must not read as a failure:
    // the state the owner asked for is the state he has.
    await store.install(DRAFT)
    await approve('example-server')
    const again = await store.decide('example-server', 'approve', await liveHash('example-server'))
    expect(again.ok).toBe(true)
    expect((await store.resolveApproved())).toHaveLength(1)
  })

  test('deciding on a server that is not installed is refused', async () => {
    const result = await store.decide('never-installed', 'approve', 'any-hash')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('never-installed')
  })

  test('installing twice does not stack two live prompts', async () => {
    // Two live rows for one grant would make "which one did he answer" a real
    // question.
    await store.install(DRAFT)
    await store.install(DRAFT)
    const pending = approvals
      .listPending(SLUG)
      .filter((r) => r.tool_name === mcpServerApprovalToolName('example-server'))
    expect(pending).toHaveLength(1)
  })

  test('an exact revert restores the original approval, deliberately', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    await store.install({ ...DRAFT, command: '/usr/local/bin/other-mcp' })
    expect(await store.resolveApproved()).toEqual([])
    // Same program, same variables, byte for byte — the grant he gave is still an
    // accurate description of what would run. Matches the ritual grants' behaviour.
    await store.install(DRAFT)
    expect((await store.list())[0]!.approval).toBe('approved')
  })
})

describe('CONCURRENT writes do not lose each other', () => {
  test('two simultaneous installs both survive', async () => {
    // `install` reads the whole list, does async secret work, then rewrites the whole
    // list. Interleaved, the second write was computed from a list taken before the
    // first landed, and one of the owner's servers silently vanished — the web tab and
    // the phone doing this at the same time is an ordinary Tuesday, not an edge case.
    await Promise.all([
      store.install({ ...DRAFT, name: 'first-server' }),
      store.install({ ...DRAFT, name: 'second-server' }),
    ])
    expect((await store.list()).map((s) => s.name).sort()).toEqual([
      'first-server',
      'second-server',
    ])
  })

  test('a simultaneous install and remove leave a coherent list', async () => {
    await store.install({ ...DRAFT, name: 'keeper' })
    await store.install({ ...DRAFT, name: 'doomed' })
    await Promise.all([
      store.remove('doomed'),
      store.install({ ...DRAFT, name: 'newcomer' }),
    ])
    expect((await store.list()).map((s) => s.name).sort()).toEqual(['keeper', 'newcomer'])
  })

  test('a FAILED install does not poison the writes that follow it', async () => {
    // The chain advances with a promise that cannot reject; a rejecting tail would make
    // the next caller throw somebody else's error.
    const bad = await store.install({ name: 'NOT A NAME', command: 'x' })
    expect(bad.ok).toBe(false)
    const good = await store.install({ ...DRAFT, name: 'after-failure' })
    expect(good.ok).toBe(true)
    expect((await store.list()).map((s) => s.name)).toEqual(['after-failure'])
  })
})

describe('the ENV payload is refused before it can fail server-side', () => {
  test('an oversized total is a complaint, not an error', async () => {
    // Each value passes the 4096-per-value check; together they exceed the credential
    // store's 8192-byte token cap, which used to surface as a thrown error from the
    // encrypted write rather than something the owner could act on.
    const big = 'x'.repeat(MCP_SERVER_ENV_VALUE_MAX)
    const result = await store.install({
      ...DRAFT,
      env: { EXAMPLE_ONE: big, EXAMPLE_TWO: big },
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('over the')
    // Nothing was stored: not the spec, and not a secret row for it.
    expect(await store.list()).toEqual([])
  })

  test('the validator cap sits BELOW the credential store cap', () => {
    // The two limits are declared in different packages (`runtime` cannot import
    // `project-credentials`), so the relationship is pinned here instead of assumed.
    expect(MCP_SERVER_ENV_TOTAL_MAX).toBeLessThan(CREDENTIAL_TOKEN_MAX)
  })

  test('a LARGE payload that fits is still accepted', async () => {
    // Two near-maximum values, together comfortably under the aggregate cap: the new
    // check must refuse only what would actually fail, or it becomes its own bug.
    const nearMax = 'y'.repeat(MCP_SERVER_ENV_VALUE_MAX - 1)
    const result = await store.install({
      ...DRAFT,
      env: { EXAMPLE_ONE: nearMax, EXAMPLE_TWO: 'z'.repeat(3000) },
    })
    expect(result.ok).toBe(true)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
  })
})

describe('a VALUE never leaves the encrypted store', () => {
  test('no status row carries one', async () => {
    await store.install(DRAFT)
    const serialized = JSON.stringify(await store.list())
    expect(serialized).toContain('EXAMPLE_API_KEY')
    expect(serialized).not.toContain(SECRET)
  })

  test('the plain `instance_metadata` column carries names only', async () => {
    await store.install(DRAFT)
    const row = db
      .prepare<{ mcp_servers: string | null }, [string]>(
        'SELECT mcp_servers FROM instance_metadata WHERE instance_slug = ?',
      )
      .get(SLUG)
    expect(row?.mcp_servers).toContain('EXAMPLE_API_KEY')
    expect(row?.mcp_servers).not.toContain(SECRET)
  })

  test('the APPROVAL row carries names only — the prompt is built from it', async () => {
    await store.install(DRAFT)
    const pending = approvals.listPending(SLUG)[0]!
    expect(pending.args_json).toContain('EXAMPLE_API_KEY')
    expect(pending.args_json).not.toContain(SECRET)
  })

  test('the stored spec survives a re-read, and a corrupt column reads as empty', async () => {
    await store.install(DRAFT)
    expect(readOwnerMcpServers(db, SLUG).map((s) => s.name)).toEqual(['example-server'])
    await db.run('UPDATE instance_metadata SET mcp_servers = ? WHERE instance_slug = ?', [
      'not json',
      SLUG,
    ])
    // A corrupt column is "nothing installed", never a throw on a spawn path.
    expect(readOwnerMcpServers(db, SLUG)).toEqual([])
    expect(await store.resolveApproved()).toEqual([])
  })

  test('a stored entry that would no longer VALIDATE is dropped on read', async () => {
    await store.install(DRAFT)
    await db.run('UPDATE instance_metadata SET mcp_servers = ? WHERE instance_slug = ?', [
      JSON.stringify([
        { name: 'neutron', command: 'x', args: [], env_names: [] },
        { name: 'example-server', command: '/usr/local/bin/example-mcp', args: [], env_names: [] },
      ]),
      SLUG,
    ])
    // The reserved name cannot re-enter through a hand-edited column; the valid
    // sibling still reads back, because one bad row must not disable the rest.
    expect(readOwnerMcpServers(db, SLUG).map((s) => s.name)).toEqual(['example-server'])
  })
})

describe('AN UNREADABLE SECRET FAILS ONE SERVER CLOSED, NOT THE WHOLE SURFACE', () => {
  // `ProjectCredentialStore.resolve` DECRYPTS INLINE, and AES-GCM throws on a malformed
  // envelope or a failed tag check. That call sat OUTSIDE `readSecrets`' try/catch, so
  // one unreadable `mcp_env.*` row did not fail its server closed — it threw out of
  // `list()` and `resolveApproved()`, which 500s the Settings GET, breaks `remove()`
  // (it lists), and rejects on every chat turn's spawn resolve. Worst of it: the owner
  // could not UNINSTALL the offending server, because the fault was on the read path the
  // uninstall needs.
  //
  // The row is corrupted directly, which is what the real failure looks like: a
  // truncated write, a restored backup, or a `secrets_key` this box no longer holds.

  async function corruptStoredSecret(): Promise<void> {
    await db.run(`UPDATE project_credentials SET ciphertext = ? WHERE service = ?`, [
      'not-a-valid-envelope',
      'mcp_env.example-server',
    ])
  }

  test('list() still answers, and reports the server as having no secrets', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    await corruptStoredSecret()

    const rows = await store.list()
    expect(rows).toHaveLength(1)
    // Still installed, still visible, still carrying its grant — so the owner can act on
    // it. `secrets_present` is what tells him why it is not running.
    expect(rows[0]!.name).toBe('example-server')
    expect(rows[0]!.secrets_present).toBe(false)
  })

  test('resolveApproved() does not throw, and does not wire the server', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)

    await corruptStoredSecret()
    // Fail CLOSED: a declared variable with no readable value is not what the owner
    // approved, so the program is not started with it unset.
    expect(await store.resolveApproved()).toEqual([])
  })

  test('the owner can still UNINSTALL it — the recovery path is not the broken one', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    await corruptStoredSecret()

    // A DELETE that finds no such server lists BEFORE it can forget anything, so this is
    // the `remove()` path the throw actually reached: the owner asks to uninstall
    // something and gets a 500 instead of an answer, on the very surface he needs in
    // order to clean up.
    expect((await store.remove('no-such-server')).removed).toBe(false)

    expect((await store.remove('example-server')).removed).toBe(true)
    expect(await store.list()).toEqual([])
  })

  test('and re-entering the value heals it, with no second approval prompt', async () => {
    // The spec never changed, so the grant hash never changed: rewriting the secret
    // restores a server the owner already approved rather than asking him again.
    await store.install(DRAFT)
    await approve('example-server')
    await corruptStoredSecret()
    expect(await store.resolveApproved()).toEqual([])

    await store.install(DRAFT)
    expect((await store.list())[0]!.approval).toBe('approved')
    expect(await store.resolveApproved()).toHaveLength(1)
  })
})

describe('A DENY IS A STOP, EVEN WHEN AN APPROVAL GOT THERE FIRST', () => {
  // Two clients make this ordinary: the phone approves while the tab still shows the
  // pending prompt, and the tab's Deny arrives second. `approvalStateFor` reads
  // `approved` FIRST — the safe precedence for reads — so a deny that merely ADDED a
  // denied row left the server WIRED while `decide` answered 200 and the settings list
  // said "denied". The owner had pressed the only stop button there is.

  test('a deny AFTER an approve of the same spec revokes it and unwires the server', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)

    const hash = await liveHash('example-server')
    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)

    expect((await store.list())[0]!.approval).toBe('denied')
    expect(await store.resolveApproved()).toEqual([])
    // Asserted on the grant table too: reporting 'denied' while an approved row is still
    // in force is exactly the shape of the bug.
    expect(approvals.findApproved(SLUG, mcpServerApprovalToolName('example-server'))).toHaveLength(0)
  })

  test('a REPEATED deny stays denied — the idempotency check reads post-revoke state', async () => {
    // The approval rows are read AFTER the revoke. Read before it, and a second deny
    // would short-circuit on its own first denied row while an approval opened in
    // between stayed live.
    await store.install(DRAFT)
    const hash = await liveHash('example-server')
    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)

    expect((await store.decide('example-server', 'deny', hash)).ok).toBe(true)
    expect(await store.resolveApproved()).toEqual([])
  })

  test('and he can still change his mind — approve after deny re-wires it', async () => {
    // The revoke must not make the server permanently un-approvable.
    await store.install(DRAFT)
    await approve('example-server')
    await store.decide('example-server', 'deny', await liveHash('example-server'))
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
  })
})

describe('UNINSTALL REVOKES BEFORE IT DROPS, so a half-done uninstall is safe', () => {
  // Three stores, no transaction across them, so the order is chosen for what a crash in
  // the middle LEAVES RUNNING. Dropping the spec first left an APPROVED grant for a
  // server that no longer existed AND no way to heal it: a retry re-reads the list, finds
  // nothing, and answers `removed: false` while the live grant sits in the table waiting
  // for a byte-identical reinstall to re-match it.

  test('the grant is revoked BEFORE the spec is dropped', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    const order: string[] = []
    const tool_name = mcpServerApprovalToolName('example-server')
    const realRevoke = approvals.revokeApproved.bind(approvals)
    const realRun = db.run.bind(db)
    approvals.revokeApproved = async (slug: string, tool: string) => {
      order.push('revoke')
      return await realRevoke(slug, tool)
    }
    db.run = async (sql: string, params?: unknown[]) => {
      if (sql.includes('instance_metadata')) order.push('spec-write')
      return await realRun(sql, params as never)
    }
    try {
      await store.remove('example-server')
    } finally {
      approvals.revokeApproved = realRevoke
      db.run = realRun
    }

    expect(order).toContain('revoke')
    expect(order).toContain('spec-write')
    expect(order.indexOf('spec-write')).toBeGreaterThan(order.indexOf('revoke'))
    expect(approvals.findApproved(SLUG, tool_name)).toHaveLength(0)
  })

  test('a FAILURE mid-uninstall leaves it unapproved-but-installed, and a retry heals it', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    const tool_name = mcpServerApprovalToolName('example-server')
    const realRun = db.run.bind(db)
    let explode = true
    db.run = async (sql: string, params?: unknown[]) => {
      if (explode && sql.includes('instance_metadata')) throw new Error('disk write refused')
      return await realRun(sql, params as never)
    }
    try {
      await expect(store.remove('example-server')).rejects.toThrow('disk write refused')

      // Fail-closed: the grant is already gone, so nothing can be wired whatever happens
      // next…
      expect(approvals.findApproved(SLUG, tool_name)).toHaveLength(0)
      expect(await store.resolveApproved()).toEqual([])
      // …and the spec is STILL THERE, so the owner sees the row he asked to delete and
      // the retry has a target. Under the old order this was `removed: false` forever,
      // with a live approval for a server that had vanished.
      expect((await store.list()).map((s) => s.name)).toEqual(['example-server'])

      explode = false
      expect((await store.remove('example-server')).removed).toBe(true)
      expect(await store.list()).toEqual([])
    } finally {
      db.run = realRun
    }
  })
})

describe('THE AUDIT ROW NAMES THE DECIDER, NOT THE BOX', () => {
  test('decided_by records the caller-supplied actor', async () => {
    // `tool_approvals.decided_by` is documented in migration 0004 as the user_id of the
    // decider. Passing the instance's project slug wrote a PLACE into a column that means
    // a PERSON, so every MCP decision in the audit trail read as having been made by the
    // box. The HTTP surface had already resolved the bearer and was discarding it.
    await store.install(DRAFT)
    await store.decide('example-server', 'approve', await liveHash('example-server'), 'u-owner-1')

    const approved = approvals
      .findByToolName(SLUG, mcpServerApprovalToolName('example-server'))
      .find((r) => r.status === 'approved')
    expect(approved?.decided_by).toBe('u-owner-1')
  })

  test('an absent actor falls back to the slug rather than writing nothing', async () => {
    // An empty decider would be worse than a coarse one: the row would stop recording
    // that anybody decided at all.
    await store.install(DRAFT)
    await store.decide('example-server', 'approve', await liveHash('example-server'), '   ')

    const approved = approvals
      .findByToolName(SLUG, mcpServerApprovalToolName('example-server'))
      .find((r) => r.status === 'approved')
    expect(approved?.decided_by).toBe(SLUG)
  })
})

describe('a decision and an uninstall cannot interleave', () => {
  /**
   * THE ORPHANED APPROVAL. `install` and `remove` were on the write chain and
   * `decide` was not, so an approve could read its spec, pass its hash check, and then
   * resume AFTER an uninstall had already deleted the spec and revoked the grant —
   * writing a fresh `approved` row for a server that no longer exists. The revoke was
   * lost because it ran before the row it was meant to kill.
   *
   * The damage is not the stray row; it is that reinstalling the IDENTICAL spec
   * produces the same grant hash, so `approvalStateFor` finds the survivor and the
   * server comes back WIRED with no approval prompt. The owner's only gate silently
   * fails open, which for a feature that executes arbitrary commands is the worst
   * available outcome.
   *
   * Forced deterministically by parking inside `respondApproval` — the call that
   * actually writes the decision — and running the uninstall while the approve sits
   * there. Two clients make that ordinary: an uninstall from the tab landing
   * mid-decision on the phone.
   */
  test('an uninstall landing DURING an approve never leaves an approved grant behind', async () => {
    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    let parkedOnce = false
    // ARMED EXPLICITLY, not by call ORDER. Parking the FIRST `openApproval` was a claim
    // about which caller happens to reach it first, and that changed the moment
    // `requestApproval` started awaiting its own mint instead of firing and forgetting
    // it: `install`'s prompt became the first call, and the setup deadlocked on a park
    // meant for the approve. A test whose target is "the first one" silently retargets
    // when the code around it changes — so the park is armed at the exact line the
    // interleave begins.
    let armed = false

    // A PROXY, not a hand-listed set of delegating methods. The first draft of this
    // enumerated the four calls `decide` makes and broke on `remove`'s
    // `listPending` — a fake built by listing what one caller happens to use drifts
    // from the real surface the moment a second caller reaches it, and the failure
    // reads as a bug in the code under test. Everything delegates; exactly one call
    // is intercepted.
    const gated = new Proxy(approvals, {
      get(target, prop, receiver) {
        if (prop !== 'openApproval') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: unknown[]): Promise<unknown> => {
          if (armed && !parkedOnce) {
            parkedOnce = true
            await parked
          }
          return await (
            target as unknown as { openApproval: (...a: unknown[]) => Promise<unknown> }
          ).openApproval(...args)
        }
      },
    })

    const racy = new OwnerMcpServerStore({
      db,
      project_slug: SLUG,
      credentials: new ProjectCredentialStore(db, {
        crypto: new SecretsStore({ data_dir: tmp, db }),
      }),
      owner_slug: asOwnerHandle(SLUG),
      approvals: () => gated,
    })

    await racy.install(DRAFT)
    const hash = (await racy.list())[0]!.grant_hash
    // DENY FIRST. Without this the approve resolves the pending row `install` already
    // opened and never calls `openApproval` at all — and `remove` cancels pending rows,
    // so that interleaving is already defended. The undefended window is the one where
    // the approve MINTS A FRESH grant (the deny-then-changed-my-mind path) after the
    // uninstall's sweep has already run and found nothing to cancel.
    expect((await racy.decide('example-server', 'deny', hash)).ok).toBe(true)

    // From here on, the next `openApproval` — the fresh grant this approve has to mint,
    // there being no pending row left to resolve — is the one that parks.
    armed = true
    const approving = racy.decide('example-server', 'approve', hash)
    // Let `decide` reach the park before the uninstall is issued.
    await new Promise((r) => setTimeout(r, 0))
    const removing = racy.remove('example-server')
    await new Promise((r) => setTimeout(r, 0))
    release?.()
    await approving
    await removing

    // The uninstall won, because it was allowed to run to completion rather than
    // half-way. Nothing is installed and nothing is wired.
    expect(await racy.list()).toEqual([])
    expect(await racy.resolveApproved()).toEqual([])

    // AND THE PART THAT MATTERS: reinstalling the identical spec must ask again. This
    // is the assertion the bug fails — a surviving approved row has the same hash, so
    // the reinstall would report `approved` and be wired without a prompt.
    await racy.install(DRAFT)
    expect((await racy.list())[0]!.approval).toBe('pending')
    expect(await racy.resolveApproved()).toEqual([])
  })
})

describe('a revocation retires what is already running', () => {
  /**
   * Revoking a grant is durable and immediate. The SUBPROCESS spawned under the old
   * answer is not: `claude` reads `mcpServers` once at startup, and the spawn path's
   * freshness guard only retires a stale child ON A DISPATCH — which for an idle
   * session can be hours away. So a revoked server's stdio child kept running with the
   * environment it was handed, including any secret configured for it.
   *
   * The store cannot reach the REPL pool (persistence layer to runtime adapter — the
   * layering gate is right to refuse that edge), so it announces the revocation and
   * `open/composer.ts` supplies the eviction.
   */
  function spyStore(onRevoked: () => Promise<void>): OwnerMcpServerStore {
    return new OwnerMcpServerStore({
      db,
      project_slug: SLUG,
      credentials: new ProjectCredentialStore(db, {
        crypto: new SecretsStore({ data_dir: tmp, db }),
      }),
      owner_slug: asOwnerHandle(SLUG),
      approvals: () => approvals,
      onRevoked,
    })
  }

  test('UNINSTALLING announces the revocation', async () => {
    let calls = 0
    const s = spyStore(async () => {
      calls += 1
    })
    await s.install(DRAFT)
    expect(calls).toBe(0)
    expect((await s.remove('example-server')).removed).toBe(true)
    expect(calls).toBe(1)
  })

  test('DENYING announces it too — a stop that leaves the process running is not a stop', async () => {
    let calls = 0
    const s = spyStore(async () => {
      calls += 1
    })
    await s.install(DRAFT)
    const hash = (await s.list())[0]!.grant_hash
    expect((await s.decide('example-server', 'deny', hash)).ok).toBe(true)
    expect(calls).toBe(1)
  })

  test('APPROVING does NOT — nothing was revoked, and thrashing the pool on approve would be a defect', async () => {
    let calls = 0
    const s = spyStore(async () => {
      calls += 1
    })
    await s.install(DRAFT)
    const hash = (await s.list())[0]!.grant_hash
    expect((await s.decide('example-server', 'approve', hash)).ok).toBe(true)
    expect(calls).toBe(0)
  })

  test('uninstalling something that is NOT installed announces nothing', async () => {
    let calls = 0
    const s = spyStore(async () => {
      calls += 1
    })
    expect((await s.remove('never-installed')).removed).toBe(false)
    expect(calls).toBe(0)
  })

  test('an eviction that FAILS does not fail the revocation', async () => {
    // The revoke has already landed durably by then. Surfacing the eviction's failure
    // would invite the owner to press Remove again on state that is already correct —
    // and would make an unrelated pool problem look like a broken uninstall.
    const s = spyStore(async () => {
      throw new Error('pool unavailable')
    })
    await s.install(DRAFT)
    expect((await s.remove('example-server')).removed).toBe(true)
    expect(await s.list()).toEqual([])
    expect(await s.resolveApproved()).toEqual([])
  })

  test('a store with NO hook behaves exactly as before', async () => {
    // Every other test in this file constructs one, so the optionality is load-bearing.
    await store.install(DRAFT)
    expect((await store.remove('example-server')).removed).toBe(true)
  })
})

describe('THE REPLY DESCRIBES THE GRANT IT JUST MINTED', () => {
  /**
   * `requestApproval` used to `fireAndForget(manager.requestApproval(...))` and then let
   * its caller finish with `await this.list()`. The INSERT goes through the db mutex;
   * `findByToolName` is a SYNCHRONOUS `prepare().all()` that does not. So the row was
   * present in the reply only when the mutex happened to be idle, and it is not always
   * idle: `install` reported the server it had just made a prompt for as `unapproved`.
   *
   * Fail-closed (nothing was wired) and the Approve control still rendered — but the
   * label read "Not approved — review the request below" for a server that had in fact
   * just asked, and the Deny button, which renders only for `pending`, was absent. The
   * fix is `await manager.openApproval(...)`: the same insert, minus the
   * wait-for-the-owner half nothing here ever consumed.
   *
   * FORCING IT DETERMINISTICALLY. Contention alone is not enough — `install`'s own two
   * writes queue on the same mutex, so by the time it reaches the mint the mutex is
   * idle again. The window is the ONE yield inside the critical section that happens
   * after those writes and before the INSERT: the `await manager.cancelPending(...)`
   * an EDIT takes to retire the prompt for the previous spec. A foreign writer taking
   * the mutex at that instant puts the INSERT behind itself. The proxy below is that
   * foreign writer, arriving at exactly that moment.
   */
  test('an EDIT answers with the fresh prompt even when a foreign writer holds the db mutex', async () => {
    let hog: Promise<void> | undefined
    const hogTheMutex = (): Promise<void> =>
      db.transaction(async (tx) => {
        for (let i = 0; i < 200; i += 1) {
          await tx.run(
            `INSERT INTO system_events (id, ts, module, event_name) VALUES (?, ?, ?, ?)`,
            [`mutex-hog-${String(i)}`, Date.now(), 'test', 'hog'],
          )
        }
      })

    // A PROXY, matching the interleave harness above: everything delegates, and exactly
    // one call is instrumented — here to start an unrelated write the moment the
    // cancel's mutex slot is released.
    const gated = new Proxy(approvals, {
      get(target, prop, receiver) {
        if (prop !== 'cancelPending') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (id: string): Promise<boolean> => {
          const out = await target.cancelPending(id)
          hog = hogTheMutex()
          return out
        }
      },
    })
    const racy = new OwnerMcpServerStore({
      db,
      project_slug: SLUG,
      credentials: new ProjectCredentialStore(db, {
        crypto: new SecretsStore({ data_dir: tmp, db }),
      }),
      owner_slug: asOwnerHandle(SLUG),
      approvals: () => gated,
    })

    await racy.install(DRAFT)
    // The EDIT: a different command, so the pending row for the old spec is cancelled
    // and a fresh grant is minted — the path that yields mid-section.
    const edited = await racy.install({ ...DRAFT, command: '/usr/local/bin/example-mcp-v2' })
    expect(edited.ok).toBe(true)
    // THE ASSERTION THE BUG FAILS: the reply that carries the new `grant_prompt` must
    // also say the owner is being asked. `unapproved` here hid the Deny button and told
    // him nothing was pending when something was.
    expect(edited.servers[0]!.approval).toBe('pending')
    expect(edited.servers[0]!.command).toBe('/usr/local/bin/example-mcp-v2')
    await hog
  })
})
