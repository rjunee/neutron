import { afterEach, beforeAll, beforeEach, expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { CodexCredentialService } from './codex-credential.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'
import { prepareCodexReconciliation as prepareInput, verifyCodexIdentity, type CodexIdentityTrust, type CodexReconciliationInput } from './codex-custody-reconciliation.ts'
import { persistCodexMaintenanceReceipt } from '@neutronai/project-credentials/codex-maintenance.ts'

const owner=asOwnerHandle('fixture-owner'),now=Date.now(),hash=(x:string)=>createHash('sha256').update(x).digest('hex')
let key:KeyLike,trust:CodexIdentityTrust,temp:string,db:ProjectDb,store:ProjectCredentialStore,service:CodexCredentialService,rotation:SqliteCodexRotationStore,input:CodexReconciliationInput,first:string,second:string
async function auth(account:string,override:Record<string,unknown>={}) {
  const token=await new SignJWT({'https://api.openai.com/auth':{chatgpt_account_id:account},...override}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://issuer.example').setAudience('fixture-client').setSubject('subject-'+account).setIssuedAt(Math.floor(now/1000)-20).setExpirationTime(Math.floor(now/1000)+3600).sign(key)
  return JSON.stringify({tokens:{account_id:account,id_token:token,access_token:token,refresh_token:'synthetic-refresh-token'},last_refresh:new Date(now-10000).toISOString()})
}
beforeAll(async()=>{const pair=await generateKeyPair('RS256');key=pair.privateKey;trust={issuer:'https://issuer.example',idAudience:'fixture-client',accessAudience:'fixture-client',jwks:{keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256'}]}}})
beforeEach(async()=>{
  temp=mkdtempSync('/tmp/codex-row-cas-');seedMigratedDb(join(temp,'db.sqlite'));db=ProjectDb.open(join(temp,'db.sqlite'))
  store=new ProjectCredentialStore(db,{crypto:new SecretsStore({data_dir:temp,db}),now:()=>new Date(now).toISOString()})
  rotation=new SqliteCodexRotationStore(db);service=new CodexCredentialService({store,rotation,codexHome:join(temp,'auth'),now:()=>now})
  first=await auth('account-first');second=await auth('account-second')
  await service.connectAccount(owner,first,{label:'First'})
  await service.connectAccount(owner,second,{slot:'second',label:'Second'})
  second=readFileSync(join(service.slotHome('second'),'auth.json'),'utf8')
  await store.setCodex(owner,{service:'codex',scope:'global',plaintext:second,label:'Preserved',expires_at:new Date(now+86400000).toISOString()})
  rotation.setActiveSlot(owner,'second',now)
  input={owner,store,lease:await store.codexCustody.beginMaintenance(owner).drained,epoch:'synthetic-held-maintenance-epoch',assertNativeExclusion:()=>{},defaultAuth:join(service.slotHome('default'),'auth.json'),namedAuth:join(service.slotHome('second'),'auth.json'),keyFile:join(temp,'.neutron-aes-key'),expectedKeyDigest:createHash('sha256').update(readFileSync(join(temp,'.neutron-aes-key'))).digest('hex'),namedService:'codex-acct-second',expectedDefaultAccountDigest:hash('account-first'),expectedNamedAccountDigest:hash('account-second'),trust,now:()=>now}
})
afterEach(()=>{db.close();rmSync(temp,{recursive:true,force:true})})
const state=()=>({credentials:db.prepare('SELECT * FROM project_credentials ORDER BY id').all(),slots:db.prepare('SELECT * FROM codex_rotation_slots ORDER BY rowid').all(),active:db.prepare('SELECT * FROM codex_rotation_active ORDER BY rowid').all()})
async function prepareCodexReconciliation(value:CodexReconciliationInput){const p=await prepareInput(value),path=join(temp,'receipt-'+crypto.randomUUID());persistCodexMaintenanceReceipt(path,p.receipt);return{...p,receipt:path}}
test('signed reconciliation changes only default ciphertext/time, preserves homes and supports both rotations',async()=>{
  const before=state(),disk=[readFileSync(input.defaultAuth),readFileSync(input.namedAuth)],meta=store.getMeta(owner,'','codex')
  const plan=await prepareCodexReconciliation(input)
  expect(readFileSync(plan.receipt,'utf8')).not.toContain('synthetic-refresh-token');expect(state()).toEqual(before)
  await expect(store.setCodex(owner,{service:'codex',scope:'global',plaintext:first})).rejects.toThrow()
  expect(await store.codexMaintenance.apply(owner,plan.authority,plan.receipt,'install')).toEqual({changed:true})
  expect(store.resolve(owner,'','codex')?.plaintext).toBe(readFileSync(input.defaultAuth,'utf8'))
  expect(store.getMeta(owner,'','codex')).toEqual(meta)
  expect(state().slots).toEqual(before.slots);expect(state().active).toEqual(before.active)
  expect(await store.codexMaintenance.apply(owner,plan.authority,plan.receipt,'install')).toEqual({changed:false})
  input.lease.release()
  expect(await service.rotateAccount(owner,{to:'default'})).toMatchObject({ok:true,active:'default'})
  expect(await service.rotateAccount(owner,{to:'second'})).toMatchObject({ok:true,active:'second'})
  expect([readFileSync(input.defaultAuth),readFileSync(input.namedAuth)]).toEqual(disk)
  input.lease=await store.codexCustody.beginMaintenance(owner).drained
  plan.authority.lease=input.lease
  await expect(store.codexMaintenance.apply(owner,plan.authority,plan.receipt,'rollback')).rejects.toThrow()
})
test('conditional rollback restores exact row and refuses after later metadata writes',async()=>{
  const before=state(),p=await prepareCodexReconciliation(input)
  await store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')
  expect(await store.codexMaintenance.apply(owner,p.authority,p.receipt,'rollback')).toEqual({changed:true});expect(state()).toEqual(before)
  await store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')
  await db.run("UPDATE project_credentials SET label='later change' WHERE service='codex'",[])
  const changed=state();await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'rollback')).rejects.toThrow();expect(state()).toEqual(changed)
})
for(const target of ['default','named','pointer','slots','new-slot'])test(`CAS refuses ${target} drift`,async()=>{
  const p=await prepareCodexReconciliation(input)
  const sql={default:"UPDATE project_credentials SET label='changed' WHERE service='codex'",named:"UPDATE project_credentials SET label='changed' WHERE service='codex-acct-second'",pointer:"UPDATE codex_rotation_active SET active_slot='default'",slots:"UPDATE codex_rotation_slots SET label='changed'",'new-slot':"UPDATE project_credentials SET service='codex-acct-third' WHERE service='codex-acct-second'"}[target]!
  await db.run(sql,[]);const changed=state();await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(changed)
})
for(const name of ['defaultAuth','namedAuth'] as const)test(`auth drift ${name} refuses`,async()=>{const p=await prepareCodexReconciliation(input),before=state();writeFileSync(input[name],'changed');await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
test('lost native fence and foreign service lease refuse',async()=>{const before=state();input.assertNativeExclusion=()=>{throw Error('not held')};await expect(prepareCodexReconciliation(input)).rejects.toThrow();expect(state()).toEqual(before);input.assertNativeExclusion=()=>{};input.lease=await store.codexCustody.beginMaintenance(asOwnerHandle('other-owner')).drained;await expect(prepareCodexReconciliation(input)).rejects.toThrow()})
test('unsigned and wrong audience/issuer/account bindings refuse',async()=>{
  const parsed=JSON.parse(first);parsed.tokens.account_id='different';await expect(verifyCodexIdentity(JSON.stringify(parsed),trust,now)).rejects.toThrow()
  await expect(verifyCodexIdentity(first,{...trust,idAudience:'wrong'},now)).rejects.toThrow()
  await expect(verifyCodexIdentity(first,{...trust,issuer:'https://wrong.example'},now)).rejects.toThrow()
  parsed.tokens.account_id='account-first';parsed.tokens.id_token=parsed.tokens.id_token.slice(0,-8)+'tampered';await expect(verifyCodexIdentity(JSON.stringify(parsed),trust,now)).rejects.toThrow()
  await expect(verifyCodexIdentity(first,trust,now+7200000)).rejects.toThrow()
})
test('expired grant and wrong independent mapping refuse',async()=>{
  const original=input.expectedDefaultAccountDigest;input.expectedDefaultAccountDigest=hash('wrong');await expect(prepareCodexReconciliation(input)).rejects.toThrow();input.expectedDefaultAccountDigest=original
  await db.run("UPDATE project_credentials SET expires_at='2000-01-01' WHERE service='codex'",[]);await expect(prepareCodexReconciliation(input)).rejects.toThrow()
})
test('trigger side effects refused before update',async()=>{const p=await prepareCodexReconciliation(input);await db.exec("CREATE TRIGGER maintenance_side_effect AFTER UPDATE ON project_credentials BEGIN UPDATE codex_rotation_active SET active_slot='default'; END");const before=state();await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before);await db.run("UPDATE project_credentials SET label=label WHERE service='codex'",[]);expect(rotation.getActiveSlot(owner)).toBe('default')})
test('external refusal after update rolls back the SQL transaction',async()=>{const p=await prepareCodexReconciliation(input),before=state();let checks=0;const original=p.authority.assertExternalHeld;p.authority.assertExternalHeld=()=>{original();if(++checks===3)throw Error('lost external fence')};await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
test('receipt corruption and changed epoch refuse',async()=>{const p=await prepareCodexReconciliation(input),before=state();await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt+'x','install')).rejects.toThrow();p.authority.epoch+='changed';await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
test('key drift refuses before encrypted row changes',async()=>{const p=await prepareCodexReconciliation(input),before=state();writeFileSync(input.keyFile,Buffer.alloc(32,7));await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
test('changed verified snapshot during signed verification refuses',async()=>{const before=state();const pending=prepareCodexReconciliation(input);await db.run("UPDATE project_credentials SET label='concurrent' WHERE service='codex'",[]);await expect(pending).rejects.toThrow();expect(store.getMeta(owner,'','codex')?.label).toBe('concurrent');expect(state().active).toEqual(before.active)})
test('extra unverified named home refuses',async()=>{await db.run("INSERT INTO project_credentials SELECT 'extra-id',owner_slug,project_id,scope,'codex-acct-extra',ciphertext,label,created_at,updated_at,expires_at FROM project_credentials WHERE service='codex-acct-second'",[]);await expect(prepareCodexReconciliation(input)).rejects.toThrow()})
test('stale named plaintext refuses despite unchanged account identity',async()=>{const changed=JSON.parse(readFileSync(input.namedAuth,'utf8'));changed.last_refresh=new Date(now-1).toISOString();writeFileSync(input.namedAuth,JSON.stringify(changed));await expect(prepareCodexReconciliation(input)).rejects.toThrow()})
test('foreign-key cascade is refused with positive cascade control',async()=>{
  const p=await prepareCodexReconciliation(input)
  await db.exec('CREATE UNIQUE INDEX fixture_ciphertext_key ON project_credentials(ciphertext); CREATE TABLE fixture_child(value TEXT REFERENCES project_credentials(ciphertext) ON UPDATE CASCADE)')
  await db.run("INSERT INTO fixture_child SELECT ciphertext FROM project_credentials WHERE service='codex'",[])
  const before=state();await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)
  await db.run("UPDATE project_credentials SET ciphertext='synthetic-cascade-control' WHERE service='codex'",[])
  expect(db.prepare<{value:string},[]>('SELECT value FROM fixture_child').get()?.value).toBe('synthetic-cascade-control')
})
test('missing or un-fsynced receipt cannot reach CAS',async()=>{
  const p=await prepareInput(input),before=state()
  await expect(store.codexMaintenance.apply(owner,p.authority,join(temp,'missing'),'install')).rejects.toThrow()
  const path=join(temp,'durability-receipt');writeFileSync(path,p.receipt,{mode:0o600})
  const spy=spyOn(fs,'fsyncSync').mockImplementation(()=>{throw Error('fsync fault')})
  try{await expect(store.codexMaintenance.apply(owner,p.authority,path,'install')).rejects.toThrow()}finally{spy.mockRestore()}
  expect(state()).toEqual(before)
})
test('sensitive failures produce no console output or exception detail',async()=>{
  const spy=spyOn(console,'error').mockImplementation(()=>{});input.assertNativeExclusion=()=>{throw Error('first line\nprivate-sentinel')}
  try{await expect(prepareCodexReconciliation(input)).rejects.toThrow('codex_reconciliation_refused_keep_fenced');expect(spy).not.toHaveBeenCalled()}finally{spy.mockRestore()}
})
test('authenticated receipt byte tampering refuses without write',async()=>{const p=await prepareCodexReconciliation(input),before=state(),bytes=readFileSync(p.receipt,'utf8'),index=Math.floor(bytes.length/2);writeFileSync(p.receipt,bytes.slice(0,index)+(bytes[index]==='A'?'B':'A')+bytes.slice(index+1));await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
test('released lease cannot regain authority by replacing its public assertion',async()=>{const p=await prepareCodexReconciliation(input),before=state();input.lease.release();input.lease.assertHeld=()=>{};await expect(store.codexMaintenance.apply(owner,p.authority,p.receipt,'install')).rejects.toThrow();expect(state()).toEqual(before)})
