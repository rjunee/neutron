/** Offline reconciliation under independently enforced native/service exclusion.
 * No HTTP route, automatic account selection, auth writes or fence release. */
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { CodexCustodyMaintenanceLease } from '@neutronai/project-credentials/codex-custody-gate.ts'
import type { CodexMaintenanceAuthority } from '@neutronai/project-credentials/codex-maintenance.ts'
import { validateCodexSubscriptionAuth } from './codex-auth.ts'

const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function check(value: unknown): asserts value { if (!value) throw new Error('codex_reconciliation_refused_keep_fenced') }
export interface CodexIdentityTrust {
  /** Independently provisioned issuer keys/policy; never derived from the bundle. */
  jwks: JSONWebKeySet
  issuer: string
  idAudience: string
  accessAudience: string
}
export interface CodexReconciliationInput {
  owner: OwnerHandle
  store: ProjectCredentialStore
  lease: CodexCustodyMaintenanceLease
  epoch: string
  assertNativeExclusion(): void
  defaultAuth: string
  namedAuth: string
  keyFile: string
  expectedKeyDigest: string
  namedService: string
  expectedDefaultAccountDigest: string
  expectedNamedAccountDigest: string
  trust: CodexIdentityTrust
  now?: () => number
}
function read(path: string): string {
  const stat = lstatSync(path)
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(path) === resolve(path))
  return readFileSync(path, 'utf8')
}
/** Signature verification, issuer, audience, expiry, subject and signed account
 * binding all precede trusting the unsigned outer account_id field. */
export async function verifyCodexIdentity(bytes: string, trust: CodexIdentityTrust, now: number): Promise<{ account: string; refreshed: number; validUntil: number }> {
  try { return await verifyIdentity(bytes,trust,now) }
  catch { throw new Error('codex_identity_verification_refused') }
}
async function verifyIdentity(bytes: string, trust: CodexIdentityTrust, now: number): Promise<{ account: string; refreshed: number; validUntil: number }> {
  check(validateCodexSubscriptionAuth(bytes).ok)
  const auth = JSON.parse(bytes), keys = createLocalJWKSet(trust.jwks)
  check(typeof trust.issuer === 'string' && trust.issuer.startsWith('https://') && trust.idAudience && trust.accessAudience)
  const [id, access] = await Promise.all([
    jwtVerify(auth.tokens.id_token, keys, { issuer: trust.issuer, audience: trust.idAudience, algorithms: ['RS256'], currentDate: new Date(now), requiredClaims: ['exp','iat','sub'] }),
    jwtVerify(auth.tokens.access_token, keys, { issuer: trust.issuer, audience: trust.accessAudience, algorithms: ['RS256'], currentDate: new Date(now), requiredClaims: ['exp','iat','sub'] }),
  ])
  const account = (id.payload['https://api.openai.com/auth'] as Record<string,unknown>)?.chatgpt_account_id
  const accessAccount = (access.payload['https://api.openai.com/auth'] as Record<string,unknown>)?.chatgpt_account_id
  check(typeof account === 'string' && account.length > 0 && account === accessAccount && auth.tokens.account_id === account)
  check(id.payload.sub === access.payload.sub && Number(id.payload.iat) * 1000 <= now && Number(access.payload.iat) * 1000 <= now)
  const refreshed = Date.parse(auth.last_refresh)
  check(Number.isFinite(refreshed) && refreshed <= now)
  return { account, refreshed, validUntil: Math.min(Number(id.payload.exp),Number(access.payload.exp))*1000 }
}

/** A prepared encrypted receipt must be persisted+fsynced by the root operator
 * before apply. Plaintext identity/account values are never returned. */
export async function prepareCodexReconciliation(input: CodexReconciliationInput): Promise<{ receipt: string; authority: CodexMaintenanceAuthority }> {
  try { return await prepareReconciliation(input) }
  catch { throw new Error('codex_reconciliation_refused_keep_fenced') }
}
async function prepareReconciliation(input: CodexReconciliationInput): Promise<{ receipt: string; authority: CodexMaintenanceAuthority }> {
  const held = () => { input.store.codexCustody.assertMaintenance(input.owner,input.lease); input.assertNativeExclusion() }
  held()
  const witness = input.store.codexMaintenance.witness(input.owner,input.lease)
  const keyUnchanged = () => {
    const stat=lstatSync(input.keyFile)
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && realpathSync(input.keyFile)===resolve(input.keyFile))
    check(/^[a-f0-9]{64}$/.test(input.expectedKeyDigest) && digest(readFileSync(input.keyFile))===input.expectedKeyDigest)
  }
  keyUnchanged()
  check(input.namedService.startsWith('codex-acct-') && input.defaultAuth !== input.namedAuth)
  check(/^[a-f0-9]{64}$/.test(input.expectedDefaultAccountDigest) && /^[a-f0-9]{64}$/.test(input.expectedNamedAccountDigest) && input.expectedDefaultAccountDigest !== input.expectedNamedAccountDigest)
  const defaultBytes = read(input.defaultAuth), namedBytes = read(input.namedAuth), now = (input.now ?? Date.now)()
  const incoming = await verifyCodexIdentity(defaultBytes,input.trust,now)
  const namedDisk = await verifyCodexIdentity(namedBytes,input.trust,now)
  check(digest(incoming.account) === input.expectedDefaultAccountDigest && digest(namedDisk.account) === input.expectedNamedAccountDigest && incoming.account !== namedDisk.account)
  const oldBytes = input.store.resolve(input.owner,'','codex')?.plaintext
  const namedStoredBytes = input.store.resolve(input.owner,'',input.namedService)?.plaintext
  check(oldBytes && namedStoredBytes)
  // The existing materializer adds a terminal newline after storing normalized
  // JSON. Permit only surrounding whitespace; token/JSON bytes must agree.
  check(namedStoredBytes.trim() === namedBytes.trim())
  const old = await verifyCodexIdentity(oldBytes,input.trust,now), namedStored = await verifyCodexIdentity(namedStoredBytes,input.trust,now)
  check(old.account === namedDisk.account && namedStored.account === namedDisk.account)
  for (const [stored, bytes] of [[old,oldBytes],[namedStored,namedStoredBytes]] as const) {
    check(stored.refreshed <= namedDisk.refreshed)
    if (stored.refreshed === namedDisk.refreshed) check(bytes.trim() === namedBytes.trim())
  }
  const namedRows=input.store.listGlobal(input.owner).filter(r=>r.service.startsWith('codex-acct-'))
  check(namedRows.length===1 && namedRows[0]?.service===input.namedService)
  for (const row of namedRows) {
    const bytes = input.store.resolve(input.owner,'',row.service)?.plaintext
    check(bytes)
    const identity = await verifyCodexIdentity(bytes,input.trust,now)
    check(identity.account !== incoming.account)
    if (row.service !== input.namedService) check(identity.account !== namedDisk.account)
  }
  const defaultDigest = digest(defaultBytes), namedDigest = digest(namedBytes)
  const authority: CodexMaintenanceAuthority = {
    lease:input.lease, epoch:input.epoch,
    binding:digest(JSON.stringify({defaultDigest,namedDigest,key:input.expectedKeyDigest,desired:input.expectedDefaultAccountDigest,peer:input.expectedNamedAccountDigest})),
    assertExternalHeld:()=>{held();keyUnchanged();check((input.now??Date.now)()<Math.min(incoming.validUntil,namedDisk.validUntil,old.validUntil,namedStored.validUntil));check(digest(read(input.defaultAuth))===defaultDigest && digest(read(input.namedAuth))===namedDigest)},
  }
  authority.assertExternalHeld()
  const receipt = input.store.codexMaintenance.prepare(input.owner,authority,defaultBytes,witness)
  return { receipt, authority }
}
