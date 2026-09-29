import { isDeepStrictEqual } from 'node:util'
import { classifyPaneForAdoption, defaultReadArgv } from './orphan-adoption.ts'
import { readProcessIdentity } from './process-identity.ts'
import type { HandleInspection } from './pty-host.ts'
import { observeNativeExecutable, recordNativeParentLaunchEvidence } from './native-parent-launch-evidence.ts'

/** Low-level observation seams; production never obtains these from a worker. */
export interface AdoptedNativeLaunchDeps {
  readIdentity?: typeof readProcessIdentity
  readArgv?: typeof defaultReadArgv
  observeExecutable?: typeof observeNativeExecutable
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
    if (!unchanged()) return undefined
    return { record(session) {
      try {
        if (unchanged()) recordNativeParentLaunchEvidence(session, { version: 1,
          sessionId: input.sessionId, childGeneration: input.childGeneration, projectId: input.projectId,
          executable: image.executable, argv, tools })
      } catch { /* observation unavailable; ordinary adoption remains usable */ }
    } }
  } catch { return undefined }
}
