import { randomBytes } from 'node:crypto'
import { NATIVE_RELAY_BASE_URL, NativeRelayUnavailable, registerClaudeNativeRelay, resolveClaudeCapacityPin,
  type ClaudeCapacityPin, type ClaudeCapacityPinSource, type NativeRelayScope } from '../../../workers/claude-capacity-client.ts'
import { readProcessIdentity } from './process-identity.ts'

const scopes = new WeakMap<object, NativeRelayScope>()
export function readNativeRequestRelay(session: object): NativeRelayScope | undefined { return scopes.get(session) }

/** Host configuration selects the transport; this is not a per-turn feature flag.
 * The native CLI still owns its request body, model selection and tools.
 * `source` is an explicit pin, an injected source, or omitted (the production
 * source, where a present broken pin throws rather than falling back). */
export function prepareNativeRequestRelay(env: Record<string, string | undefined>,
  source?: ClaudeCapacityPin | ClaudeCapacityPinSource): {
    env: Record<string, string | undefined>
    register(session: { sessionId: string; child: { pid: number } }): Promise<void>
  } | undefined {
  const pin = resolveClaudeCapacityPin(source)
  if (!pin) return undefined
  const scopeToken = randomBytes(32).toString('base64url')
  const routed = { ...env }
  for (const key of Object.keys(routed)) {
    if (/^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|CLAUDE_CODE_(?:API_KEY|OAUTH_TOKEN|HOST_AUTH|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|CCR_OAUTH_TOKEN_FILE)/.test(key)) delete routed[key]
  }
  const headers = (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').filter(line => line.trim()
    && !/^(?:x-neutron-native-scope|authorization|x-api-key)\s*:/i.test(line.trim()))
  routed.ANTHROPIC_UNIX_SOCKET = pin.socketPath
  // The registered local socket speaks HTTP, not TLS. Port zero makes a CLI
  // that ignores its Unix transport fail locally rather than send scope/auth
  // headers to a network endpoint. The host alone owns verified provider TLS.
  routed.ANTHROPIC_BASE_URL = NATIVE_RELAY_BASE_URL
  routed.CLAUDE_CODE_OAUTH_TOKEN = 'ssh-placeholder'
  routed.ANTHROPIC_CUSTOM_HEADERS = [...headers, `x-neutron-native-scope: ${scopeToken}`].join('\n')
  return { env: routed, async register(session) {
    try {
      const identity = readProcessIdentity(session.child.pid)
      if (!identity) throw Error('Unknown native parent')
      const scope = await registerClaudeNativeRelay(pin, { parentSessionId: session.sessionId,
        parentPid: session.child.pid, parentStartTicks: identity.start_ticks, bootId: identity.boot_id }, scopeToken,
      AbortSignal.timeout(10_000), Date.now() + 10_000)
      scopes.set(session, scope)
    } catch { throw new NativeRelayUnavailable('Native quota relay parent registration is unavailable; input was refused') }
  } }
}
