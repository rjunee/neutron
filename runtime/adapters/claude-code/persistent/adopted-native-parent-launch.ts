import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import { loadClaudeCapacityPin, NATIVE_RELAY_BASE_URL, registerClaudeNativeRelay,
  type ClaudeCapacityPin } from '../../../workers/claude-capacity-client.ts'
import { classifyPaneForAdoption, defaultReadArgv } from './orphan-adoption.ts'
import { readProcessIdentity } from './process-identity.ts'
import type { HandleInspection } from './pty-host.ts'
import { observeNativeExecutable, recordNativeParentLaunchEvidence } from './native-parent-launch-evidence.ts'

/** Low-level observation seams; production never obtains these from a worker. */
export interface AdoptedNativeLaunchDeps {
  readIdentity?: typeof readProcessIdentity
  readArgv?: typeof defaultReadArgv
  observeExecutable?: typeof observeNativeExecutable
  loadRelayPin?: typeof loadClaudeCapacityPin
  readEnvironment?: (pid: number) => string | undefined
}

/** Recover only the survivor's original capability, never mint a replacement. */
function originalScope(environment: string | undefined, pin: ClaudeCapacityPin): string | undefined {
  if (!environment || environment.length > 1024 * 1024) return undefined
  const entries = environment.split('\0')
  const value = (key: string) => {
    const matches = entries.filter(entry => entry.startsWith(`${key}=`))
    return matches.length === 1 ? matches[0]!.slice(key.length + 1) : undefined
  }
  if (value('ANTHROPIC_UNIX_SOCKET') !== pin.socketPath || value('ANTHROPIC_BASE_URL') !== NATIVE_RELAY_BASE_URL) return undefined
  const headers = value('ANTHROPIC_CUSTOM_HEADERS')?.split(/\r?\n/)
    .filter(header => /^\s*x-neutron-native-scope\s*:/i.test(header))
  if (headers?.length !== 1) return undefined
  const token = headers[0]!.slice(headers[0]!.indexOf(':') + 1).trim()
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

/** Remeasure an authenticated survivor; registry labels supply no tool evidence.
 * Missing process evidence or ambiguous argv leaves continuation unknown without
 * preventing ordinary ownership adoption. This observes the kernel executable
 * file, not mutable process memory or the served tools. */
export async function prepareAdoptedNativeParentLaunch(input: {
  pid: number; sessionId: string; childGeneration: string; projectId: string
  channelName: string; cwd: string; claudeBasename: string
  argv: readonly string[]; inspect(): Promise<HandleInspection>
}, deps: AdoptedNativeLaunchDeps = {}): Promise<{ record(session: object): void } | undefined> {
  try {
    if (!input.projectId || !input.childGeneration || !Number.isSafeInteger(input.pid) || input.pid <= 0) return undefined
    const readIdentity = deps.readIdentity ?? readProcessIdentity
    const readArgv = deps.readArgv ?? defaultReadArgv
    const loadPin = deps.loadRelayPin ?? loadClaudeCapacityPin
    const readEnvironment = deps.readEnvironment ?? (pid => readFileSync(`/proc/${pid}/environ`, 'utf8'))
    const pin = loadPin()
    const scopeToken = pin ? originalScope(readEnvironment(input.pid), pin) : undefined
    if (pin && !scopeToken) return undefined
    const before = readIdentity(input.pid)
    const observedArgv = readArgv(input.pid)
    if (!before || !observedArgv || !isDeepStrictEqual(observedArgv, input.argv)) return undefined
    const argv = [...observedArgv]
    const values = (flag: string) => argv.flatMap((arg, index) => arg === flag ? [argv[index + 1]] : [])
    const sessions = [...values('--session-id'), ...values('--resume')]
    const grants = values('--tools')
    if (sessions.length !== 1 || sessions[0] !== input.sessionId || grants.length !== 1 || typeof grants[0] !== 'string'
      || values('--dangerously-load-development-channels').length !== 1) return undefined
    const tools = grants[0].split(',')
    if (!tools.includes('Agent') || !tools.includes('SendMessage') || new Set(tools).size !== tools.length) return undefined
    const hostMatches = async () => {
      const host = await input.inspect()
      return host.kind === 'live' && host.pid === input.pid && isDeepStrictEqual(host.argv, argv)
        && classifyPaneForAdoption(host, input, input.claudeBasename).kind === 'adopt'
    }
    if (!await hostMatches()) return undefined
    // The configured launcher may have been upgraded since this survivor began.
    const image = await (deps.observeExecutable ?? observeNativeExecutable)(`/proc/${input.pid}/exe`, input.cwd, {})
    if (!image || !await hostMatches()) return undefined
    const unchanged = () => isDeepStrictEqual(readIdentity(input.pid), before)
      && isDeepStrictEqual(readArgv(input.pid), argv) && image.isCurrent()
      && isDeepStrictEqual(loadPin(), pin)
      && (!pin || originalScope(readEnvironment(input.pid), pin) === scopeToken)
    if (!unchanged()) return undefined
    // The protected host authenticates the same physical parent and signs a new
    // challenge for its original scope. Re-registration preserves host bindings.
    const relay = pin && scopeToken ? await registerClaudeNativeRelay(pin, {
      parentSessionId: input.sessionId, parentPid: input.pid,
      parentStartTicks: before.start_ticks, bootId: before.boot_id,
    }, scopeToken, AbortSignal.timeout(10_000), Date.now() + 10_000) : undefined
    if (!unchanged() || !await hostMatches()) return undefined
    return { record(session) {
      try {
        if (unchanged()) recordNativeParentLaunchEvidence(session, { version: 1,
          sessionId: input.sessionId, childGeneration: input.childGeneration, projectId: input.projectId,
          executable: image.executable, argv, tools, ...(relay ? { relay } : {}) })
      } catch { /* observation unavailable; ordinary adoption remains usable */ }
    } }
  } catch { return undefined }
}
