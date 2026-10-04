import { expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { verifyHostTerminatedChatProof } from '../host-terminated-chat-proof.ts'

function fixture(currentBoot = 'new-boot') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = <T>(body: T) => ({ body, signature: sign(null, Buffer.from(JSON.stringify(body)), privateKey).toString('base64') })
  const sha = (raw: string) => createHash('sha256').update(raw).digest('hex')
  const captured = { sessionKey: 'exact-key', sessionId: 'original-session', child_generation: 'original-generation',
    pid: 123, adoption_claim_pid: 456, conversationProjectId: 'project-a', model: 'original-model', cwd: '/tmp/fixture',
    channelName: 'neutron-11112222333344445555666677778888', has_session: true }
  const registry = JSON.stringify({ 'exact-key': captured })
  const bundle = JSON.stringify({ policy: 'retained-quota-local-repl-v1', identity: { hostId: 'host', instanceId: 'instance',
    bootId: 'old-boot', sessionId: captured.sessionId, childGeneration: captured.child_generation, nativePid: 123, gatewayPid: 456 },
    registry: { path: '/never-read-this-path', sha256: sha(registry) } })
  const scope = { ownerHandle: 'owner', projectId: 'project-a' }
  const preparation = signed({ version: 1, kind: 'native-host-termination-preparation', operationId: 'operation',
    hostId: 'host', instanceId: 'instance', bootId: 'old-boot', evidenceDigest: sha(bundle),
    lease: { scope, generation: 0, token: 'token', reason: 'liveChild', producer: 'producer', workRef: '["run","step"]' } })
  const boot = (challenge: string) => signed({ version: 1, kind: 'host-boot', hostId: 'host', instanceId: 'instance', bootId: currentBoot, challenge })
  const row = { operationId: 'operation', scope, preparation: JSON.stringify(preparation),
    termination: JSON.stringify({ version: 1, kind: 'terminated-by-host-reboot', operationId: 'operation', preparation, observation: boot('consumed') }) }
  const authority = { hostId: 'host', instanceId: 'instance', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    attestBoot: async (challenge: string) => boot(challenge) }
  const request = { operationId: 'operation', projectId: 'project-a', bundle, registry }
  return { row, request, authority, captured }
}

test('consumed signed exact byte preimages identify the original parent on a freshly attested new boot', async () => {
  const f = fixture()
  expect(await verifyHostTerminatedChatProof(f.request, f.row, f.authority, () => 'new-boot')).toEqual(f.captured)
})

test('correctly signed observations of the original boot do not prove parent death', async () => {
  const f = fixture('old-boot')
  expect(await verifyHostTerminatedChatProof(f.request, f.row, f.authority, () => 'old-boot')).toBeUndefined()
  const valid = fixture()
  expect(await verifyHostTerminatedChatProof(valid.request, valid.row, valid.authority, () => 'new-boot')).toEqual(valid.captured)
})

test.each(['bundle', 'registry', 'scope', 'operation', 'signature', 'unconsumed', 'same-boot', 'foreign-boot', 'fresh-challenge', 'missing-authority'] as const)
('refuses %s while accepting the unmodified proof', async change => {
  const f = fixture()
  const valid = () => verifyHostTerminatedChatProof(f.request, f.row, f.authority, () => 'new-boot')
  expect(await valid()).toEqual(f.captured)
  const request = { ...f.request }, row = { ...f.row }, authority = { ...f.authority }
  if (change === 'bundle') request.bundle += ' '
  if (change === 'registry') request.registry += ' '
  if (change === 'scope') request.projectId = 'foreign'
  if (change === 'operation') request.operationId = 'foreign'
  if (change === 'signature') row.preparation = row.preparation.replace('original', 'changed').replace('operation', 'forged')
  if (change === 'unconsumed') row.termination = ''
  if (change === 'fresh-challenge') authority.attestBoot = async () => JSON.parse(f.row.termination).observation
  const boot = change === 'same-boot' ? 'old-boot' : change === 'foreign-boot' ? 'foreign-boot' : 'new-boot'
  expect(await verifyHostTerminatedChatProof(request, row, change === 'missing-authority' ? undefined : authority, () => boot)).toBeUndefined()
})
