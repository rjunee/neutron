import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { issueCapRearmAuthorization } from '../sign-repl-cap-rearm.ts'
import { verifyCapRearmAuthorization, type CapRearmAuthorization } from '../operator-cap-rearm-authorization.ts'

const pair = generateKeyPairSync('ed25519')
const authority = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  hostId: 'host', instanceId: 'instance', attestBoot: async () => undefined }
const request = { projectId: 'project', sessionKey: 'key', sessionId: 'session', childGeneration: 'generation', cappedAt: 1 }
const now = 1000000
const key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const issue = () => issueCapRearmAuthorization(request, '/operator-key', 'host', 'instance',
  { uid: () => 0, readKey: () => Buffer.from(key), now: () => now }) as { body: CapRearmAuthorization; signature: string }

test('root issues exact short-lived instruction; non-root fails before accessing a key', () => {
  const envelope = issue()
  expect(verifyCapRearmAuthorization(envelope, authority, now)).toEqual(request)
  expect(JSON.stringify(envelope)).not.toContain('PRIVATE KEY')
  let reads = 0
  expect(() => issueCapRearmAuthorization(request, '/operator-key', 'host', 'instance',
    { uid: () => 1000, readKey: () => { reads++; return Buffer.from(key) } })).toThrow()
  expect(reads).toBe(0)
  expect(verifyCapRearmAuthorization(request, authority, now)).toBeUndefined()
  expect(verifyCapRearmAuthorization(envelope, undefined, now)).toBeUndefined()
})

test.each(['host', 'instance', 'pin', 'kind', 'expired', 'future', 'long-lived', 'altered-request', 'embedded-key'] as const)(
  '%s cannot authorize cap release', bad => {
    const envelope = issue()
    let pin = authority
    if (bad === 'host') pin = { ...authority, hostId: 'foreign' }
    if (bad === 'instance') pin = { ...authority, instanceId: 'foreign' }
    if (bad === 'pin') pin = { ...authority, publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    if (bad === 'kind') (envelope.body as { kind: string }).kind = 'native-host-termination-preparation'
    if (bad === 'expired') envelope.body.expiresAt = now
    if (bad === 'future') envelope.body.issuedAt = now + 1
    if (bad === 'long-lived') envelope.body.expiresAt = now + 300001
    if (bad === 'altered-request') envelope.body.request.childGeneration = 'foreign'
    if (bad === 'embedded-key') {
      const foreign = generateKeyPairSync('ed25519')
      Object.assign(envelope, { publicKey: foreign.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
      envelope.signature = sign(null, Buffer.from(JSON.stringify(envelope.body)), foreign.privateKey).toString('base64')
    } else if (!['altered-request', 'pin', 'host', 'instance'].includes(bad)) {
      // Semantically invalid but correctly signed: failures exercise validation,
      // not merely tampered signature bytes.
      envelope.signature = sign(null, Buffer.from(JSON.stringify(envelope.body)), pair.privateKey).toString('base64')
    }
    expect(verifyCapRearmAuthorization(envelope, pin, now)).toBeUndefined()
    expect(verifyCapRearmAuthorization(issue(), authority, now)).toEqual(request)
  })
