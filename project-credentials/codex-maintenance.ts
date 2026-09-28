/** Explicit offline maintenance; never exposed through generic CRUD or HTTP. */
import type { OwnerHandle, ProjectDb } from '@neutronai/persistence/index.ts'
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { SecretCrypto } from './store.ts'
import type { CodexCustodyMaintenanceLease, CodexServiceCustodyGate } from './codex-custody-gate.ts'

type Row = Record<string, string | number | null>
type Snapshot = { credentials: Row[]; slots: Row[]; active: Row[] }
interface Receipt { version: 1; owner: string; epoch: string; binding: string; before: Snapshot; after: Snapshot }
export interface CodexMaintenanceAuthority {
  lease: CodexCustodyMaintenanceLease
  epoch: string
  /** Stable digest binding the independently validated identity/auth/key inputs. */
  binding: string
  /** Must enforce host-wide exclusion AND unchanged auth/key inputs. A service
   * lease alone is insufficient. This callback never authorizes fence release. */
  assertExternalHeld(): void
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function requireSafe(value: unknown): asserts value {
  if (!value) throw new Error('codex_maintenance_refused_keep_fenced')
}

/** Private regular file, owner-only directory, no symlinks. Re-fsync on every
 * apply makes durability a precondition at the mutation boundary, not prose. */
function durableReceipt(path: string): string {
  const parent=dirname(resolve(path)), d=lstatSync(parent), s=lstatSync(path)
  requireSafe(d.isDirectory() && (d.mode&0o777)===0o700 && realpathSync(parent)===parent)
  requireSafe(s.isFile() && !s.isSymbolicLink() && s.nlink===1 && (s.mode&0o777)===0o600 && realpathSync(path)===resolve(path))
  requireSafe(s.uid===process.getuid?.() && d.uid===s.uid)
  for(const file of [path,parent]) { const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try { fsyncSync(fd) } finally { closeSync(fd) } }
  return readFileSync(path,'utf8')
}
export function persistCodexMaintenanceReceipt(path: string, encryptedReceipt: string): void {
  try { writeFileSync(path,encryptedReceipt,{mode:0o600,flag:'wx'});durableReceipt(path) }
  catch { throw new Error('codex_maintenance_receipt_not_durable') }
}

export class CodexCredentialMaintenance {
  constructor(private readonly db: ProjectDb, private readonly crypto: SecretCrypto,
    private readonly gate: CodexServiceCustodyGate, private readonly now: () => string) {}

  private assert(owner: OwnerHandle, authority: CodexMaintenanceAuthority): void {
    this.gate.assertMaintenance(owner, authority.lease)
    requireSafe(authority.epoch.length >= 16 && /^[a-f0-9]{64}$/.test(authority.binding))
    authority.assertExternalHeld()
  }

  private snapshot(owner: OwnerHandle): Snapshot {
    // An UPDATE trigger can mutate unrelated data despite changes() === 1.
    requireSafe(this.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='project_credentials' UNION ALL SELECT name FROM sqlite_temp_master WHERE type='trigger' AND tbl_name='project_credentials'").all().length === 0)
    // SQLite implements foreign-key cascades as internal triggers, invisible
    // to sqlite_master and changes(). Refuse any inbound credential reference.
    const tables=this.db.prepare<{name:string},[]>('SELECT name FROM sqlite_master WHERE type=\'table\' UNION ALL SELECT name FROM sqlite_temp_master WHERE type=\'table\'').all()
    for(const table of tables) {
      const refs=this.db.prepare<{table:string},[]>(`PRAGMA foreign_key_list("${table.name.replaceAll('"','""')}")`).all()
      requireSafe(refs.every(ref=>ref.table.toLowerCase()!=='project_credentials'))
    }
    return {
      credentials: this.db.prepare<Row, [string]>("SELECT * FROM project_credentials WHERE owner_slug=? AND project_id='' AND (service='codex' OR service LIKE 'codex-acct-%') ORDER BY service").all(owner),
      slots: this.db.prepare<Row, [string]>('SELECT * FROM codex_rotation_slots WHERE owner_slug=? ORDER BY rowid').all(owner),
      active: this.db.prepare<Row, [string]>('SELECT * FROM codex_rotation_active WHERE owner_slug=? ORDER BY rowid').all(owner),
    }
  }

  /** Authenticated receipt contains encrypted row images; persist and fsync it
   * before commit. No DB mutation occurs here. The owner module must first verify
   * signed identity, account distinctness and exact auth bytes under the fence. */
  witness(owner: OwnerHandle, lease: CodexCustodyMaintenanceLease): string {
    this.gate.assertMaintenance(owner,lease)
    return createHash('sha256').update(JSON.stringify(this.snapshot(owner))).digest('hex')
  }

  prepare(owner: OwnerHandle, authority: CodexMaintenanceAuthority, plaintext: string, witness: string): string {
    try { return this.prepareInternal(owner,authority,plaintext,witness) }
    catch { throw new Error('codex_maintenance_refused_keep_fenced') }
  }

  private prepareInternal(owner: OwnerHandle, authority: CodexMaintenanceAuthority, plaintext: string, witness: string): string {
    this.assert(owner, authority)
    requireSafe(this.witness(owner,authority.lease) === witness)
    requireSafe(plaintext.length > 0 && plaintext.length <= 8192)
    const before = this.snapshot(owner), old = before.credentials.find(r => r.service === 'codex')
    requireSafe(old && old.scope === 'global')
    requireSafe(old.expires_at === null || Date.parse(String(old.expires_at)) > Date.parse(this.now()))
    const after: Snapshot = structuredClone(before)
    const next = after.credentials.find(r => r.service === 'codex')!
    next.ciphertext = this.crypto.encryptPlaintext(plaintext)
    next.updated_at = this.now()
    this.assert(owner, authority)
    return this.crypto.encryptPlaintext(JSON.stringify({ version: 1, owner, epoch: authority.epoch, binding: authority.binding, before, after } satisfies Receipt))
  }

  /** The receipt must already be durable. Exceptions after a successful commit
   * are UNKNOWN until readback: retrying never blindly repeats the mutation. */
  async apply(owner: OwnerHandle, authority: CodexMaintenanceAuthority, receiptPath: string, direction: 'install' | 'rollback'): Promise<{ changed: boolean }> {
    try { return await this.applyInternal(owner,authority,receiptPath,direction) }
    catch { throw new Error('codex_maintenance_unknown_keep_fenced') }
  }

  private async applyInternal(owner: OwnerHandle, authority: CodexMaintenanceAuthority, receiptPath: string, direction: 'install' | 'rollback'): Promise<{ changed: boolean }> {
    this.assert(owner, authority)
    requireSafe(direction === 'install' || direction === 'rollback')
    const envelope=durableReceipt(receiptPath)
    const receipt: Receipt = JSON.parse(this.crypto.decryptEnvelope(envelope))
    requireSafe(receipt.version === 1 && receipt.owner === owner && receipt.epoch === authority.epoch && receipt.binding === authority.binding)
    const before = direction === 'install' ? receipt.before : receipt.after
    const after = direction === 'install' ? receipt.after : receipt.before
    const expected = before.credentials.find(r => r.service === 'codex'), replacement = after.credentials.find(r => r.service === 'codex')
    requireSafe(expected && replacement && equal({ ...replacement, ciphertext: expected.ciphertext, updated_at: expected.updated_at }, expected))
    requireSafe(equal({ ...after, credentials: after.credentials.map(r => r.service === 'codex' ? expected : r) }, before))
    return this.db.transaction(async tx => {
      this.assert(owner, authority)
      requireSafe(durableReceipt(receiptPath)===envelope)
      const current = this.snapshot(owner)
      if (equal(current, after)) return { changed: false }
      requireSafe(equal(current, before))
      requireSafe(expected.expires_at === null || Date.parse(String(expected.expires_at)) > Date.parse(this.now()))
      const columns = ['id','owner_slug','project_id','scope','service','ciphertext','label','created_at','updated_at','expires_at']
      await tx.run(`UPDATE project_credentials SET ciphertext=?, updated_at=? WHERE ${columns.map(c => `${c} IS ?`).join(' AND ')}`,
        [replacement.ciphertext!, replacement.updated_at!, ...columns.map(c => expected[c]!)])
      requireSafe(tx.prepare<{ count: number }, []>('SELECT changes() AS count').get()?.count === 1)
      requireSafe(equal(this.snapshot(owner), after))
      this.assert(owner, authority)
      return { changed: true }
    })
  }
}
