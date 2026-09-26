import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const READY = '.neutron-bun-cache.json'
const VERSION = 1

function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function privateDirectory(path: string, uid: number): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700
    || realpathSync(path) !== path) throw new Error('Native Bun cache requires a canonical private owned directory')
}

function ready(path: string, source: string, uid: number): void {
  privateDirectory(path, uid)
  const marker = join(path, READY)
  const stat = lstatSync(marker)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Native Bun cache readiness record is untrusted')
  }
  const record = JSON.parse(readFileSync(marker, 'utf8'))
  if (record.version !== VERSION || record.source !== source || record.uid !== uid) {
    throw new Error('Native Bun cache readiness identity changed')
  }
}

/** Host-side seeding never copies bytes. Publishing by rename means concurrent
 * native owners can only adopt a complete cache; no process lifetime is a lease.
 * This does not defend against a hostile process with the same UID. */
export function prepareNativeBunCache(source: string, scratch: string, uid: number): string {
  if (!isAbsolute(source) || !isAbsolute(scratch) || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Native Bun cache requires absolute paths and a Unix owner')
  }
  scratch = realpathSync(scratch)
  source = resolve(source)
  if (present(source)) {
    const stat = lstatSync(source)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(source) !== source || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error('Native Bun source cache must be canonical and owned')
    }
  }
  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const cache = join(scratch, `neutron-bun-cache-${uid}-${key}`)
  if (present(cache)) {
    ready(cache, source, uid)
    return cache
  }
  const stage = mkdtempSync(join(scratch, `.neutron-bun-cache-${uid}-`))
  try {
    privateDirectory(stage, uid)
    const seed = (from: string, to: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.name === READY) continue
        const input = join(from, entry.name), output = join(to, entry.name)
        const stat = lstatSync(input)
        // Bun's cache can mark executable package bins 0777. Do not chmod a
        // shared inode: the private destination directory controls access.
        if (stat.uid !== uid) throw new Error('Native Bun source cache entry has a foreign owner')
        if (entry.isDirectory()) {
          mkdirSync(output, { mode: 0o700 }); seed(input, output)
        } else if (entry.isFile()) {
          linkSync(input, output)
          const original = lstatSync(input), linked = lstatSync(output)
          if (original.dev !== linked.dev || original.ino !== linked.ino) throw new Error('Native Bun cache seed was copied')
        } else if (entry.isSymbolicLink()) {
          // Resolve before checking containment: lexical normalization misses
          // symlink/.. traversal. Dangling and cyclic aliases must also refuse.
          const within = relative(source, realpathSync(input))
          if (within === '..' || within.startsWith('../')) throw new Error('Native Bun cache link escapes source')
          // Bun's version lookup aliases are absolute. Relocate internal aliases
          // so they cannot route future installs back across the sandbox mount.
          symlinkSync(relative(dirname(output), join(stage, within)) || '.', output)
        } else throw new Error('Native Bun cache contains an unsupported file')
      }
    }
    if (present(source)) seed(source, stage)
    writeFileSync(join(stage, READY), JSON.stringify({ version: VERSION, source, uid }), { mode: 0o600, flag: 'wx' })
    try { renameSync(stage, cache) } catch (error) {
      // Another preparation may have atomically published first. Its complete,
      // trusted identity is required; all other rename failures remain failures.
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      ready(cache, source, uid)
    }
    ready(cache, source, uid)
    return cache
  } catch (error) {
    throw new Error('Native Bun cache preparation refused; restore an owned hardlink-capable scratch/cache path before retrying', { cause: error })
  } finally {
    // Only this invocation's freshly created staging directory is eligible.
    if (existsSync(stage)) rmSync(stage, { recursive: true })
  }
}

export function nativeBunEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  if (process.platform !== 'linux') return { ...env }
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Native Bun cache Unix owner is unavailable')
  const source = env.BUN_INSTALL_CACHE_DIR
    ?? join(env.BUN_INSTALL ?? join(env.HOME ?? homedir(), '.bun'), 'install', 'cache')
  return { ...env, BUN_INSTALL_CACHE_DIR: prepareNativeBunCache(source, tmpdir(), uid) }
}
