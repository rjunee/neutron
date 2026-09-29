import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveNativeModel, type NativeModelResolution } from './native-model-resolution.ts'
import type { NativeFileAuthObservation } from './native-file-auth.ts'

export const NATIVE_CONTINUATION_PROFILE = Object.freeze({ version: '2.1.285',
  sha256: '33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29' })
export type NativeModelLaunchEvidence = Extract<NativeModelResolution, { status: 'resolved' }> & {
  pin: { parentModel: string; environmentKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL'; value: string }
}

/** Hash checks alone cannot exclude swap-and-restore. Only the independently
 * protected installed binary may run the native local metadata command. */
export function protectedNativeExecutable(path: string): boolean {
  return protectedNativePath(path, false)
}

/** Keep the configured launcher spelling for survivor adoption, but protect
 * its directory entry too: a mutable symlink could otherwise swap and restore. */
export function protectedNativeLauncher(path: string): boolean {
  return protectedNativePath(path, true) && protectedNativeExecutable(realpathSync(path))
}

function protectedNativePath(path: string, symlink: boolean): boolean {
  try {
    if (!isAbsolute(path) || !symlink && realpathSync(path) !== path) return false
    const file = lstatSync(path)
    if (!(file.isFile() || symlink && file.isSymbolicLink()) || file.uid !== 0
      || !file.isSymbolicLink() && (file.mode & 0o022) !== 0) return false
    for (let dir = dirname(path);;) {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || realpathSync(dir) !== dir) return false
      const parent = dirname(dir); if (parent === dir) return true; dir = parent
    }
  } catch { return false }
}

/** Pin only the alias whose installed native Agent path has been checked.
 * Other aliases need their own compatibility evidence, not a guessed map. */
export function nativeModelPin(result: NativeModelResolution): NativeModelLaunchEvidence | undefined {
  if (result.status !== 'resolved' || result.selector !== 'fable' || result.authEvidence.apiKeySource !== 'none'
    || result.executableSha256 !== NATIVE_CONTINUATION_PROFILE.sha256
    || !/^claude-fable-\d[a-z0-9.-]*$/.test(result.modelId)) return undefined
  return { ...result, pin: { parentModel: result.modelId, environmentKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL', value: result.modelId } }
}

/** Original fresh launch only. A resolver result never upgrades a running
 * parent, supplies auth authority or changes the original bounded request. */
export async function prepareNativeModelLaunch(input: {
  argv: readonly string[]; cwd: string; env: Record<string, string | undefined>
  executable: { realPath: string; sha256: string; version: string }
  auth: NativeFileAuthObservation
}, deps: { resolve: typeof resolveNativeModel; protectedExecutable: typeof protectedNativeExecutable } = {
  resolve: resolveNativeModel, protectedExecutable: protectedNativeExecutable,
}): Promise<{ argv: string[]; env: Record<string, string | undefined>; evidence: NativeModelLaunchEvidence; current(): boolean } | undefined> {
  try {
    if (input.executable.version !== NATIVE_CONTINUATION_PROFILE.version
      || input.executable.sha256 !== NATIVE_CONTINUATION_PROFILE.sha256
      || !deps.protectedExecutable(input.executable.realPath) || !input.auth.current()) return undefined
    const models = input.argv.flatMap((arg, i) => arg === '--model' ? [i + 1] : [])
    const settings = input.argv.flatMap((arg, i) => arg === '--settings' ? [input.argv[i + 1]] : [])
    if (models.length !== 1 || input.argv[models[0]!] !== 'fable' || settings.length !== 1 || !settings[0]
      || input.argv.some(arg => arg === '--resume' || arg.startsWith('--setting-sources'))) return undefined
    const env = { ...input.env }, profileId = randomUUID()
    const settingsJson = readFileSync(settings[0], 'utf8')
    const result = await deps.resolve({ executable: { path: input.executable.realPath, sha256: input.executable.sha256 },
      selector: 'fable', cwd: input.cwd, env, settingsJson, settingSources: ['user', 'project', 'local'], profileId })
    const evidence = nativeModelPin(result)
    if (!evidence || !input.auth.current() || !isDeepStrictEqual(env, input.env)
      || readFileSync(settings[0], 'utf8') !== settingsJson || !deps.protectedExecutable(input.executable.realPath)) return undefined
    const argv = [...input.argv]; argv[models[0]!] = evidence.modelId
    env[evidence.pin.environmentKey] = evidence.modelId
    const pinnedEnv = { ...env }
    return { argv, env, evidence, current: () => input.auth.current() && isDeepStrictEqual(env, pinnedEnv)
      && deps.protectedExecutable(input.executable.realPath) }
  } catch { return undefined }
}
