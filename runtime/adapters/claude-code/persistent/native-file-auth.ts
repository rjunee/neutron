import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface NativeFileAuthEvidence { configDir: string; settingsDigest: string }
export interface NativeFileAuthObservation { evidence: NativeFileAuthEvidence; current(): boolean }

/** No credential values are retained. Unknown host/descriptor/provider routes
 * are not the mutable file-auth destination owned by the capacity service. */
export function hasCompetingClaudeAuth(env: Record<string, string | undefined>): boolean {
  return Object.entries(env).some(([key, value]) => Boolean(value) && (
    /^ANTHROPIC_(?!DEFAULT_.*_MODEL$|MODEL$)/.test(key)
    || /^CLAUDE_CODE_(?:OAUTH|API_KEY|HOST_|AUTH|PROVIDER_|USE_|PROXY_AUTH|SESSION_ACCESS|SDK_HAS_)/.test(key)
    || key === 'CCR_OAUTH_TOKEN_FILE' || key === 'CLAUDE_CONFIG_FILE' || key === 'CLAUDE_CODE_SETTINGS_PATH'
    || key === 'CLAUDE_CODE_MANAGED_SETTINGS_PATH'))
}

/** Observe fresh launch INPUTS, not a running process's effective credentials.
 * Conservatively reject auth-affecting settings in any source; never emulate
 * precedence or run a helper. A modified/replaced/added source revokes admission.
 * No credential file is read. The caller separately binds the fresh process. */
export function observeNativeFileAuth(input: { cwd: string; argv: readonly string[]; env: Record<string, string | undefined> },
  policyDir = '/etc/claude-code'): NativeFileAuthObservation | undefined {
  try {
    if (process.platform !== 'linux' || hasCompetingClaudeAuth(input.env)) return undefined
    const configDir = input.env.CLAUDE_CONFIG_DIR ?? (input.env.HOME ? join(input.env.HOME, '.claude') : '')
    if (!isAbsolute(configDir) || realpathSync(configDir) !== resolve(configDir)) return undefined
    const config = resolve(configDir)
    const args = input.argv
    // A custom source selector, wrapper or inline settings needs its own proof.
    if (args.some(arg => arg.startsWith('--setting-sources') || arg.startsWith('--settings=') || arg === '--bare' || arg === '--safe-mode')) return undefined
    const settings = args.flatMap((arg, i) => arg === '--settings' ? [args[i + 1]] : [])
    if (settings.length > 1 || settings.some(path => !path || !isAbsolute(path))) return undefined
    const paths = new Set<string>([join(config, 'settings.json'), join(config, 'settings.local.json'),
      join(config, 'remote-settings.json'), join(config, '.claude.json'),
      ...(input.env.HOME ? [join(input.env.HOME, '.claude.json')] : []),
      join(policyDir, 'managed-settings.json'), ...settings as string[]])
    // Superset of project/local sources, including ancestors: ignoring a source
    // cannot become an accidental permission to use an alternate account.
    for (let cwd = resolve(input.cwd);;) {
      paths.add(join(cwd, '.claude', 'settings.json')); paths.add(join(cwd, '.claude', 'settings.local.json'))
      const parent = dirname(cwd); if (parent === cwd) break; cwd = parent
    }
    const snapshot = () => {
      if (hasCompetingClaudeAuth(input.env)) throw Error('Launch environment changed')
      if (realpathSync(config) !== config) throw Error('Config changed')
      // An implicit Anthropic profile is a different auth source. Do not inspect
      // its credential files or guess whether a cached login will outrank it.
      const profile = join(input.env.XDG_CONFIG_HOME ?? join(input.env.HOME ?? config, '.config'), 'anthropic')
      try { lstatSync(profile); throw Error('Profile auth is unproven') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const sources = new Set(paths), dropIns = join(policyDir, 'managed-settings.d')
      try {
        const dir = lstatSync(dropIns)
        if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('Policy source unknown')
        const names = readdirSync(dropIns).filter(name => name.endsWith('.json') && !name.startsWith('.'))
        if (names.length > 64) throw Error('Too many policy sources')
        for (const name of names) sources.add(join(dropIns, name))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const digest = createHash('sha256')
      for (const path of [...sources].sort()) {
        digest.update(JSON.stringify(path))
        let fd: number
        try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { digest.update('absent'); continue } throw error }
        try {
          const stat = fstatSync(fd, { bigint: true })
          if (!stat.isFile() || stat.nlink !== 1n || stat.size > 65536n || realpathSync(path) !== path) throw Error('Settings source unknown')
          const bytes = readFileSync(fd), value = JSON.parse(bytes.toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || ['primaryApiKey', 'apiKey', 'apiKeyHelper', 'env', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper', 'processWrapper']
              .some(key => Object.hasOwn(value, key))) throw Error('Competing settings auth')
          const after = fstatSync(fd, { bigint: true })
          if (stat.size !== after.size || stat.ctimeNs !== after.ctimeNs || stat.mtimeNs !== after.mtimeNs) throw Error('Settings changed')
          digest.update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).update(bytes)
        } finally { closeSync(fd) }
      }
      return digest.digest('hex')
    }
    const evidence = Object.freeze({ configDir: config, settingsDigest: snapshot() })
    return { evidence, current() { try { return snapshot() === evidence.settingsDigest } catch { return false } } }
  } catch { return undefined }
}
