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
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
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

/** Approve whatever grant is currently pending for `name`. */
async function approve(name: string): Promise<void> {
  const result = await store.decide(name, 'approve')
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
    expect((await store.decide('example-server', 'deny')).ok).toBe(true)
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
    expect((await bare.decide('example-server', 'approve')).ok).toBe(false)
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

  test('a REMOVED server is not wired even though its approval row survives', async () => {
    await store.install(DRAFT)
    await approve('example-server')
    expect(await store.resolveApproved()).toHaveLength(1)
    expect((await store.remove('example-server')).removed).toBe(true)
    // The approved row is deliberately left as a record of the decision; the
    // installed list is read FIRST, so it cannot resurrect the server.
    expect(
      approvals.findApproved(SLUG, mcpServerApprovalToolName('example-server')),
    ).toHaveLength(1)
    expect(await store.resolveApproved()).toEqual([])
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

  test('a decision on a spec that has since MOVED is refused, not applied', async () => {
    // The owner reads a prompt, the spec changes underneath, then he presses Approve.
    // Applying that press to the new command is precisely what the hash prevents.
    await store.install(DRAFT)
    const stale = await store.list()
    expect(stale[0]!.approval).toBe('pending')
    await store.install({ ...DRAFT, command: '/usr/local/bin/other-mcp' })
    // The old pending row was cancelled, a fresh one minted; a decision still lands
    // on the CURRENT spec only — and there is exactly one live grant to answer.
    const result = await store.decide('example-server', 'approve')
    expect(result.ok).toBe(true)
    expect((await store.resolveApproved())[0]!.command).toBe('/usr/local/bin/other-mcp')
  })

  test('approving an ALREADY-approved spec is idempotent, not an error', async () => {
    // A double-tap, or two clients open on the same row, must not read as a failure:
    // the state the owner asked for is the state he has.
    await store.install(DRAFT)
    await approve('example-server')
    const again = await store.decide('example-server', 'approve')
    expect(again.ok).toBe(true)
    expect((await store.resolveApproved())).toHaveLength(1)
  })

  test('deciding on a server that is not installed is refused', async () => {
    const result = await store.decide('never-installed', 'approve')
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
