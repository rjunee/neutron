import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapCodexOwner, readCodexOwnerBinding, type CodexOwnerBootstrap } from './project-control-bootstrap.ts'
import { BROKER_MAX_MESSAGE_BYTES } from './project-control-broker-transport.ts'
import { OwnerHelperRegistry } from './project-owner-helper-registry.ts'
import { assertOwnerScope, exactFacts, helperIdentity, object, requireIndependentOwnerHost, socketIdentity, type HelperIdentity, type OwnerHelperDescriptor } from './project-owner-helper-protocol.ts'

/** The caller must launch this helper through an independent durable host.
 * Closing a frontend never calls this service's destroy operation.
 */
export async function startCodexOwnerHelper(options: Parameters<typeof bootstrapCodexOwner>[0] & { projectId: string | null; gatewayIdentity: HelperIdentity }) {
  requireIndependentOwnerHost(options.gatewayIdentity)
  assertOwnerScope(options.codexHome, options.projectId)
  const socketPath = join(options.codexHome, '.neutron-owner-helper.sock')
  const descriptorPath = join(options.codexHome, '.neutron-owner-helper.json')
  if (existsSync(socketPath) || existsSync(descriptorPath)) throw new Error('Existing owner helper requires reconciliation')
  const owner = await bootstrapCodexOwner(options)
  try { return serveOwnerHelper(owner, socketPath, descriptorPath, options.projectId) }
  catch (error) { await owner.close(); throw error }
}

function serveOwnerHelper(owner: CodexOwnerBootstrap, socketPath: string, descriptorPath: string, projectId: string | null) {
  const facts = readCodexOwnerBinding(owner.binding)
  const helper = helperIdentity()
  const token = randomBytes(32).toString('hex')
  const assertOwner = () => { assertOwnerScope(facts.codexHome, projectId); readCodexOwnerBinding(owner.binding) }
  const registry = new OwnerHelperRegistry(owner.broker, assertOwner)
  let observation = 0
  const respond = (value: Record<string, unknown>) => Response.json({ ...value, state: owner.broker.state(), observation: ++observation })
  const server = Bun.serve({ unix: socketPath, maxRequestBodySize: BROKER_MAX_MESSAGE_BYTES,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/owner' || request.headers.has('origin')
        || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Refused', { status: 403 })
      try {
        assertOwner()
        const raw: unknown = await request.json()
        if (!object(raw)) throw new Error('Invalid owner helper request')
        if (raw.operation === 'attach') {
          exactFacts(raw.expected, facts)
          if (typeof raw.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(raw.challenge)) throw new Error('Invalid attachment challenge')
          return respond({ facts, helper, challenge: raw.challenge, ...registry.attach() })
        }
        return respond(await registry.handle(raw, request.signal))
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Owner helper unavailable' }, { status: 409 }) }
    },
  })
  chmodSync(socketPath, 0o600)
  const descriptor: OwnerHelperDescriptor = { version: 1, socketPath, socketIdentity: socketIdentity(socketPath), token, helper, facts }
  try { writeFileSync(descriptorPath, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 }) }
  catch (error) { registry.destroy(); server.stop(true); throw error }
  return { descriptorPath, facts, async destroy() { registry.destroy(); server.stop(true); await owner.close() } }
}
