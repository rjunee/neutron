import { createPrivateKey, sign } from 'node:crypto'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
import { assertRootProtectedPath } from './native-host-recovery-authority.ts'
import { readHostTerminationPreparation } from './prepare-native-host-termination.ts'
import { isCapRearmRequest } from '@neutronai/runtime/adapters/claude-code/persistent/operator-cap-rearm.ts'
import { CAP_REARM_AUTHORIZATION_MS, type CapRearmAuthorization } from './operator-cap-rearm-authorization.ts'

function readSigningKey(path: string): Buffer {
  assertRootProtectedPath(path, 'file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error('Unsafe signing key')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

/** Root deliberately issues one short-lived instruction. The private key never
 * enters the envelope; consumers independently choose their protected public pin. */
export function issueCapRearmAuthorization(request: unknown, keyPath: string, hostId: string, instanceId: string,
  deps: { uid?: () => number | undefined; readKey?: (path: string) => Buffer; now?: () => number } = {}): unknown {
  if ((deps.uid ?? (() => process.geteuid?.()))() !== 0 || !isCapRearmRequest(request)
    || !hostId.trim() || !instanceId.trim()) throw new Error('Operator cap authorization refused')
  const key = createPrivateKey((deps.readKey ?? readSigningKey)(keyPath))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Operator key is not Ed25519')
  const issuedAt = (deps.now ?? Date.now)()
  const body: CapRearmAuthorization = { version: 1, kind: 'operator-repl-cap-rearm', hostId, instanceId,
    issuedAt, expiresAt: issuedAt + CAP_REARM_AUTHORIZATION_MS, request: structuredClone(request) }
  return { body, signature: sign(null, Buffer.from(JSON.stringify(body)), key).toString('base64') }
}

if (import.meta.main) {
  try {
    // Positional arguments are operator-selected identity and a ROOT-PROTECTED
    // key path. No worker-provided path or verification key reaches the server.
    if (process.argv.length !== 5) throw new Error('Arguments required')
    const envelope = issueCapRearmAuthorization(await readHostTerminationPreparation(process.stdin),
      process.argv[2]!, process.argv[3]!, process.argv[4]!)
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } catch { process.stderr.write('Operator cap authorization refused\n'); process.exitCode = 1 }
}
