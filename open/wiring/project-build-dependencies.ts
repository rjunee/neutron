import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { hostname, release } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { HOST_SUITE_ENV } from '@neutronai/trident/host-suite.ts'
import { createLogger } from '@neutronai/logger'
import type { SuiteIdentityMeasurement } from '@neutronai/trident/project-suite-receipt.ts'

const log = createLogger('project-build')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export const PROJECT_DEPENDENCIES_TIMEOUT_MS = 10 * 60_000
export const PROJECT_INSTALL_RESERVE_BYTES = 5n * 1024n ** 3n
// One wall budget for the complete byte walk, including local link targets.
// A full installation can exceed five seconds on a busy shared host.
export const PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS = 30_000

/** Measure blocks available to the installer, including filesystem reservations. */
export async function projectInstallAvailableBytes(worktree: string): Promise<bigint | null> {
  try {
    const observed = await statfs(worktree, { bigint: true })
    if (observed.bavail < 0n || observed.bsize <= 0n) return null
    return observed.bavail * observed.bsize
  } catch { return null }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const hostDirectory = fileURLToPath(new URL('../../', import.meta.url))
const hostVerifier = join(hostDirectory, 'scripts/ci/verify-workspace-deps.ts')
const hostInstalledTreeProbe = fileURLToPath(new URL('./project-build-installed-tree.py', import.meta.url))
const RECEIPT_VERSION = 2

// Run resolution in a new host-controlled process: Bun caches resolutions in a
// long-lived host, which could otherwise conceal removal of a local package.
// Resolving does not load project code. Consistently unresolved optional/type
// packages remain unknown; a package resolved outside the tree is never local
// installation evidence, even when the general readiness verifier tolerates it.
const RESOLUTION_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[1]);
const observations = [];
for (const manifestPath of JSON.parse(process.argv[2])) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).sort();
  for (const dependency of dependencies) {
    let target;
    // Bun's importer is a file: a directory can skip its package-local links.
    try { target = Bun.resolveSync(dependency, path.join(root, manifestPath)); }
    catch { observations.push([manifestPath, dependency, null]); continue; }
    const actual = fs.realpathSync(target);
    if (!actual.startsWith(root + path.sep)) process.exit(3);
    observations.push([manifestPath, dependency, path.relative(root, actual)]);
  }
}
console.log(JSON.stringify(observations));
`

async function workspaceManifests(worktree: string, workspaces: unknown[]): Promise<string[] | null> {
  const files = new Set(['package.json'])
  for (const workspace of workspaces) {
    if (typeof workspace !== 'string' || workspace.startsWith('!') || workspace.split('/').includes('..')) return null
    for await (const path of new Bun.Glob(`${workspace}/package.json`).scan({ cwd: worktree, onlyFiles: true })) files.add(path)
  }
  return [...files].sort()
}

async function resolutionKey(worktree: string, workspaces: unknown[], bun: string,
  portable?: { resolution?: string }): Promise<string | null> {
  const manifests = await workspaceManifests(worktree, workspaces)
  if (!manifests) return null
  const result = await spawnCapture([bun, '--config=/dev/null', '--no-env-file', '--eval', RESOLUTION_PROBE,
    worktree, JSON.stringify(manifests)], hostDirectory, undefined, 30_000)
  if (!result.ok || result.timed_out || result.stdout.length > 1024 * 1024) return null
  // A successful process is not proof of a complete resolution transcript.
  // Keep unavailable resolution explicit, including repositories without a manifest.
  let observations: unknown
  try { observations = JSON.parse(result.stdout) } catch { return null }
  if (!Array.isArray(observations) || !observations.every(row => Array.isArray(row) && row.length === 3
    && typeof row[0] === 'string' && typeof row[1] === 'string' && (row[2] === null || typeof row[2] === 'string'))) return null
  const root = await realpath(worktree)
  const paths = [...new Set(observations.flatMap(row => row[2] === null ? [] : [resolve(root, row[2])]))].sort()
  const measured = new Map<string, string[]>()
  const deadline = performance.now() + 5000
  // Bound argv as well as the native observation. Optional unresolved packages
  // remain explicit nulls; resolved entrypoints get the same confined byte read.
  for (let offset = 0; offset < paths.length; offset += 64) {
    const fields = await installedEntries(root, paths.slice(offset, offset + 64), deadline, spawnCapture)
    for (let index = 0; index < fields.length; index += 12) {
      if (fields[index + 7] !== 'f') return null
      measured.set(fields[index]!, fields.slice(index + 1, index + 12))
    }
  }
  if (paths.some(path => !measured.has(path))) return null
  if (portable) portable.resolution = digest(JSON.stringify(observations.map(row => [...row,
    row[2] === null ? null : (() => {
      const fields = measured.get(resolve(root, row[2]))!
      return [fields[2], fields[6], fields[8], fields[9], fields[10]]
    })()])))
  return digest(JSON.stringify(observations.map(row => [...row,
    row[2] === null ? null : measured.get(resolve(root, row[2]))])))
}

/** The receipt is a host observation, never a tracked project file. Hash all
 * declared workspace manifests, including uncommitted dependency edits. */
async function preparationKey(worktree: string, workspaces: unknown[], executable: string): Promise<string | null> {
  const head = await spawnCapture(['git', 'rev-parse', '--verify', 'HEAD'], worktree)
  if (!head.ok || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) return null
  const manifests = await workspaceManifests(worktree, workspaces)
  if (!manifests) return null
  const files = new Set([...manifests, 'bun.lock', 'bun.lockb', 'bunfig.toml', '.npmrc',
    'scripts/ci/verify-workspace-deps.ts'])
  const hash = createHash('sha256')
  const tool = await lstat(executable)
  const pythonCommand = Bun.which('python3', { PATH: process.env.PATH ?? '' })
  if (!pythonCommand) return null
  const python = await realpath(pythonCommand), pythonTool = await lstat(python)
  hash.update(JSON.stringify([RECEIPT_VERSION, await realpath(worktree), head.stdout.trim(),
    process.platform, process.arch, process.version, Bun.version, executable,
    [tool.dev, tool.ino, tool.size, tool.mtimeMs, tool.ctimeMs], await readFile(hostVerifier, 'utf8'),
    RESOLUTION_PROBE, await readFile(hostInstalledTreeProbe, 'utf8'),
    [python, pythonTool.dev, pythonTool.ino, pythonTool.size, pythonTool.mtimeMs, pythonTool.ctimeMs],
    '--frozen-lockfile', '--ignore-scripts']))
  for (const path of [...files].sort()) {
    const full = resolve(worktree, path)
    if (!full.startsWith(`${resolve(worktree)}${sep}`)) return null
    hash.update(JSON.stringify([path, await exists(full)]))
    if (!await exists(full)) continue
    if (!(await lstat(full)).isFile() || !(await realpath(full)).startsWith(`${await realpath(worktree)}${sep}`)) return null
    hash.update(await readFile(full))
  }
  return hash.digest('hex')
}

/** The host helper pins ancestry and regular files before reading bytes. Its
 * transient ctime checks catch in-read writes; only the saved regular-file key
 * omits ctime, which also changes when another installation links a cache inode. */
async function installedEntries(root: string, batch: string[], deadline: number,
  run: typeof spawnCapture): Promise<string[]> {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining <= 0) throw Error('deadline')
  const workspace = await lstat(root)
  if (!workspace.isDirectory()) throw Error('workspace-not-directory')
  const python = Bun.which('python3', { PATH: process.env.PATH ?? '' })
  if (!python) throw Error('missing-python')
  const measured = await run([await realpath(python), '-I', '-S', hostInstalledTreeProbe,
    root, String(workspace.dev), String(workspace.ino), JSON.stringify(batch), String(remaining)],
    hostDirectory, { LC_ALL: 'C' }, remaining)
  if (measured.timed_out) throw Error('probe-timeout')
  if (!measured.ok) throw Error('probe-exit')
  if (measured.stdout.length > 64 * 1024 * 1024) throw Error('output-limit')
  if (!measured.stdout.endsWith('\0') || measured.stdout.includes('\uFFFD')) throw Error('invalid-output')
  const fields = measured.stdout.split('\0')
  fields.pop()
  if (fields.length === 0 || fields.length % 12 !== 0) throw Error('invalid-fields')
  for (let index = 0; index < fields.length; index += 12) {
    const path = fields[index]!
    if (!batch.some(base => path === base || path.startsWith(`${base}${sep}`))) throw Error('path-outside-batch')
    if (!fields.slice(index + 1, index + 5).every(value => /^\d+$/.test(value))
      || !fields.slice(index + 5, index + 7).every(value => /^-?\d+$/.test(value))
      || !fields.slice(index + 10, index + 12).every(value => /^\d+$/.test(value))) throw Error('invalid-metadata')
    const kind = fields[index + 7]
    if (kind !== 'f' && kind !== 'd' && kind !== 'l') throw Error('unsupported-entry')
    if (kind === 'f') {
      if (!/^[a-f0-9]{64}$/.test(fields[index + 9]!)) throw Error('missing-content')
      fields[index + 6] = '0'
    } else if (fields[index + 9] !== '') throw Error('unexpected-content')
    if (kind === 'd' && !path.slice(root.length + 1).split(sep).includes('node_modules')) {
      fields[index + 4] = '0'
      fields[index + 5] = '0'
      fields[index + 6] = '0'
    }
  }
  return fields
}

/** A bounded native byte/metadata walk avoids one JS filesystem round trip per file.
 * NUL fields preserve arbitrary whitespace; undecodable names refuse reuse.
 * The helper never follows links: the host validates their targets before measuring
 * additional local roots, so an external tree is never traversed. */
export async function projectInstalledTreeIdentity(worktree: string,
  run: typeof spawnCapture = spawnCapture,
  portable?: { installed?: string; covered?: string[] }): Promise<string | null> {
  const started = performance.now()
  const refuse = (reason: string): null => {
    log.warn('suite_installed_identity_unavailable', { workspace: digest(worktree), reason,
      elapsed_ms: Math.round(performance.now() - started) })
    return null
  }
  try {
  const root = await realpath(worktree)
  const modules = join(root, 'node_modules')
  if (!await exists(modules)) {
    if (portable) { portable.installed = digest('absent'); portable.covered = [] }
    return 'absent'
  }
  if (!(await lstat(modules)).isDirectory()) return refuse('modules-not-directory')
  const hash = createHash('sha256')
  const covered: string[] = []
  const portableEntries = new Map<string, string[]>()
  let pending = [modules]
  const deadline = performance.now() + PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS
  while (pending.length > 0) {
    const batch = pending.sort()
    pending = []
    covered.push(...batch)
    const fields = await installedEntries(root, batch, deadline, run)
    const links: string[] = []
    for (let index = 0; index < fields.length; index += 12) {
      const path = fields[index]!
      const kind = fields[index + 7]
      if (kind === 'l') links.push(path)
      // Filesystem identities remain in the installation key and in the native
      // race checks. Cross-workspace proof compares relative names and bytes.
      if (portable) portableEntries.set(path.slice(root.length + 1), [fields[index + 3]!, kind!,
        fields[index + 8]!, fields[index + 9]!, fields[index + 10]!, fields[index + 11]!])
    }
    hash.update(fields.join('\0') + '\0')
    // Resolve only links, in bounded groups; ordinary files require no JS stat.
    for (let offset = 0; offset < links.length; offset += 64) {
      if (performance.now() >= deadline) return refuse('deadline')
      const targets = await Promise.all(links.slice(offset, offset + 64).map(path => realpath(path)))
      for (const [index, actual] of targets.entries()) {
        if (!actual.startsWith(`${root}${sep}`)) return refuse('external-link')
        if (portable) {
          const entry = portableEntries.get(links[offset + index]!.slice(root.length + 1))!
          // Keep the declared relative target as well as its final resolution.
          // Absolute links are location dependent, even when currently local.
          if (entry[2]!.startsWith('/')) portable.installed = 'nonportable'
          entry.push(actual.slice(root.length + 1))
        }
        if (!covered.some(base => actual === base || actual.startsWith(`${base}${sep}`))
          && !pending.includes(actual)) pending.push(actual)
      }
    }
  }
  if (performance.now() >= deadline) return refuse('deadline')
  if (portable && portable.installed !== 'nonportable') {
    portable.installed = digest(JSON.stringify([...portableEntries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
    portable.covered = covered.map(path => path.slice(root.length + 1))
  }
  return hash.digest('hex')
  } catch (error) {
    const reason = error instanceof Error && /^(deadline|probe-timeout|probe-exit|output-limit|invalid-output|invalid-fields|path-outside-batch|invalid-metadata|unsupported-entry|missing-content|unexpected-content|workspace-not-directory|missing-python)$/.test(error.message)
      ? error.message : 'filesystem-or-process-error'
    return refuse(reason)
  }
}

const toolDigests = new Map<string, string>()
/** The measured first-party runner closure: every file `scripts/run-tests.sh`
 * reads or executes, transitively. The shard planner, its profile validator and
 * the committed measured profile are suite inputs (#1447). Changed bytes, or a
 * runner dependency outside this list, refuse portable reuse; the closure guard
 * in open/__tests__/project-suite-identity.test.ts derives it from the sources. */
export const PORTABLE_RUNNER_FILES: readonly string[] = ['scripts/run-tests.sh', 'scripts/lib/discover-test-files.sh',
  'scripts/ci/verify-workspace-deps.ts', 'scripts/lib/shard-partition.ts', 'scripts/lib/test-cost-profile.ts',
  'scripts/lib/test-cost-profile.json']
const PORTABLE_RUNNER_TUNING = new Set(['NEUTRON_TEST_JOBS', 'NEUTRON_TEST_CONCURRENCY',
  'NEUTRON_TEST_CHUNK_SIZE', 'NEUTRON_TEST_TIMEOUT', 'NEUTRON_TEST_PGLITE_RETRIES',
  'NEUTRON_TEST_PGLITE_CONCURRENCY', 'NEUTRON_TEST_PGLITE_TIMEOUT'])
const PORTABLE_RUNNER_TOOLS = ['dirname', 'sysctl', 'nproc', 'find', 'sort', 'grep', 'tail', 'awk',
  'mktemp', 'rm', 'sed', 'cat', 'wc', 'tr', 'sleep']

// The admitted selector is Bun's default Linux system-shell rule (bash/sh/zsh),
// with no CLI/config override. We measure its entire candidate set, including
// absent candidates; an inner /proc sample cannot recover an interpreter which
// already exec'd Bash. This is deliberately not a claim about that transient PID.
const BUN_SYSTEM_SHELL_CANDIDATES = ['bash', 'sh', 'zsh']

/** The generated runner observes its actual Bash parent and child environment.
 * Environment values other than executable/PATH coordinates leave only as
 * digests. Only the three known package fields and package PATH slots normalize. */
const BUN_LAUNCHER_PROBE = String.raw`
import hashlib,json,os,sys
root=sys.argv[1]
baseline=json.loads(sys.argv[2])
def digest(value): return hashlib.sha256(value.encode()).hexdigest()
env=dict(os.environ)
path=env.get('PATH','').split(':')
expected=[root+'/node_modules/.bin',root+'/node_modules/.bin']
parent=os.path.dirname(root)
while True:
 expected.append(parent.rstrip('/')+'/node_modules/.bin')
 if parent=='/': break
 parent=os.path.dirname(parent)
prefix=len(expected)
if path[:prefix]!=expected: sys.exit(3)
if digest(':'.join(path[prefix:]))!=baseline.get('PATH'): sys.exit(3)
if any(not part.startswith('/') for part in path): sys.exit(3)
if env.get('BASH_ENV','') or env.get('ENV',''): sys.exit(3)
known={'PATH','PWD','SHLVL','_','NODE','npm_command','npm_config_local_prefix',
 'npm_config_user_agent','npm_execpath','npm_lifecycle_event','npm_lifecycle_script',
 'npm_node_execpath','npm_package_json','npm_package_name','npm_package_version'}
for name in set(env)|set(baseline):
 if name not in known and (digest(env[name]) if name in env else None)!=baseline.get(name): sys.exit(3)
if env.get('PWD')!=root or env.get('npm_config_local_prefix')!=root or env.get('npm_package_json')!=root+'/package.json': sys.exit(3)
if env.get('npm_command')!='run-script' or env.get('npm_lifecycle_event')!='test' or env.get('npm_lifecycle_script')!='bash scripts/run-tests.sh': sys.exit(3)
env['PWD']='<package>'; env['npm_config_local_prefix']='<package>'; env['npm_package_json']='<package>/package.json'
normalized=['<package>/node_modules/.bin']*2+path[2:]
env['PATH']=':'.join(normalized)
shellopts=sys.argv[3].split(':'); bashopts=sys.argv[4].split(':')
if not set(shellopts)<=set(['braceexpand','hashall','interactive-comments']): sys.exit(3)
if not set(bashopts)<=set(['checkwinsize','cmdhist','complete_fullquote','extquote','force_fignore','globasciiranges','globskipdots','hostcomplete','interactive_comments','patsub_replacement','progcomp','promptvars','sourcepath']): sys.exit(3)
print(json.dumps({'path':normalized,'innerBash':os.path.realpath('/proc/%s/exe'%os.getppid()),
 'node':env.get('NODE'),'npmNode':env.get('npm_node_execpath'),'bun':env.get('npm_execpath'),
 'environment':digest(json.dumps(sorted(env.items()))),
 'startup':digest(json.dumps([env.get('BASH_ENV'),env.get('ENV'),shellopts,bashopts]))}))
`

async function bunPackageLauncherIdentity(worktree: string, command: string): Promise<string | null> {
  if (process.platform !== 'linux') return null
  const root = await realpath(worktree)
  const inheritedPath = process.env.PATH ?? ''
  if (!inheritedPath.split(':').every(part => isAbsolute(part))) return null
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(BUN_|npm_|NPM_)/.test(name) || name.startsWith('NODE_') && name !== 'NODE_ENV'
      || ['NODE', 'SHELLOPTS', 'BASHOPTS'].includes(name)
      || name === 'ENV' && value) return null
  }
  // The package launcher automatically loads local dotenv/configuration. Only
  // the existing first-party bunfig (checked by portableSuiteIdentity) is known.
  if ((await readdir(root)).some(name => name === '.env' || name.startsWith('.env.'))
    || await exists(join(root, '.npmrc'))) return null
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest?.scripts?.test !== 'bash scripts/run-tests.sh'
    || Object.hasOwn(manifest.scripts, 'pretest') || Object.hasOwn(manifest.scripts, 'posttest')) return null
  if (await exists(join(root, 'bunfig.toml'))) {
    const config = await readFile(join(root, 'bunfig.toml'))
    if (!config.equals(await readFile(join(hostDirectory, 'bunfig.toml')))
      || Object.hasOwn(Bun.TOML.parse(config.toString()), 'run')) return null
  }
  const bunPath = Bun.which('bun', { PATH: inheritedPath })
  const pythonPath = Bun.which('python3', { PATH: inheritedPath })
  const nodePath = Bun.which('node', { PATH: inheritedPath })
  const bashPath = Bun.which('bash', { PATH: inheritedPath })
  if (!bunPath || !pythonPath || !nodePath || !bashPath) return null
  const bun = await realpath(bunPath), python = await realpath(pythonPath), node = await realpath(nodePath)
  if (node === bun) return null // Bun's generated node alias is not a measured Node.
  const bash = await realpath(bashPath)
  // A custom shell may interpret the probe differently before it can report.
  // Admit only the same system candidates that the default selector can use.
  const systemPath = '/usr/bin:/bin'
  const systemBash = Bun.which('bash', { PATH: systemPath })
  if (!systemBash || bash !== await realpath(systemBash)) return null
  const measureTools = async (vector: string[]): Promise<[string, string | null][] | null> => {
    const effectivePath = vector.join(':')
    const tools: [string, string | null][] = []
    for (const name of [...BUN_SYSTEM_SHELL_CANDIDATES, 'bun', 'node', 'python3', ...PORTABLE_RUNNER_TOOLS]) {
      const selected = Bun.which(name, { PATH: effectivePath })
      const inherited = Bun.which(name, { PATH: inheritedPath })
      if (selected !== inherited) return null
      if (BUN_SYSTEM_SHELL_CANDIDATES.includes(name)) {
        const system = Bun.which(name, { PATH: systemPath })
        if (Boolean(selected) !== Boolean(system) || selected && await realpath(selected) !== await realpath(system!)) return null
      }
      if (!selected && !['zsh', 'sysctl', 'nproc'].includes(name)) return null
      tools.push([name, selected ? await toolContentIdentity(selected) : null])
    }
    if (process.env.SHELL && !await Promise.all(BUN_SYSTEM_SHELL_CANDIDATES.map(async name => {
      const selected = Bun.which(name, { PATH: effectivePath })
      return selected !== null && await realpath(process.env.SHELL!) === await realpath(selected)
    })).then(values => values.some(Boolean))) return null
    return tools
  }
  // Admission precedes execution: a sibling probe inherits the same ancestor
  // bins, so discovering a shadow only from its output would already run it.
  // Derive only the admitted PATH rule, then require the actual observation to
  // match this vector and these tool bytes after each probe.
  const prospectivePath = [join(root, 'node_modules/.bin'), join(root, 'node_modules/.bin')]
  for (let parent = dirname(root);; parent = dirname(parent)) {
    prospectivePath.push(join(parent, 'node_modules/.bin'))
    if (dirname(parent) === parent) break
  }
  prospectivePath.push(...inheritedPath.split(':'))
  const baseline = Object.fromEntries(Object.entries({ ...process.env, ...HOST_SUITE_ENV })
    .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => [name, digest(value)]))
  for (const line of command.split('\n').slice(0, -1)) {
    const [, name, value] = /^export ([A-Z_]+)=([0-9]+)$/.exec(line)!
    baseline[name!] = digest(value!)
  }
  const observations: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const admittedTools = await measureTools(prospectivePath)
    if (!admittedTools) return null
    // Same parent preserves every ancestor PATH slot. No project file is changed.
    const probe = await mkdtemp(join(dirname(root), '.suite-launcher-probe-'))
    try {
      await mkdir(join(probe, 'scripts'))
      await writeFile(join(probe, 'package.json'), JSON.stringify(manifest))
      if (await exists(join(root, 'bunfig.toml'))) await writeFile(join(probe, 'bunfig.toml'), await readFile(join(root, 'bunfig.toml')))
      await writeFile(join(probe, 'scripts/run-tests.sh'),
        `${quote(python)} -I -S -c ${quote(BUN_LAUNCHER_PROBE)} "$PWD" ${quote(JSON.stringify(baseline))} "$SHELLOPTS" "$BASHOPTS"\n`)
      const result = await spawnCapture([bash, '--noprofile', '--norc', '-c', command], probe, HOST_SUITE_ENV, 10_000)
      if (!result.ok || result.timed_out || result.stdout.length > 256 * 1024) {
        log.warn('suite_launcher_probe_refused', { exit: result.exit_code }); return null
      }
      const record = JSON.parse(result.stdout) as { path: string[]; innerBash: string; node: string; npmNode: string; bun: string; environment: string; startup: string }
      if (!Array.isArray(record.path) || !record.path.every(part => typeof part === 'string')
        || record.innerBash !== bash || record.node !== nodePath || record.npmNode !== nodePath
        || record.bun !== bun || !/^[a-f0-9]{64}$/.test(record.environment) || !/^[a-f0-9]{64}$/.test(record.startup)) {
        log.warn('suite_launcher_probe_record_refused', { bash: record.innerBash === bash, node: record.node === nodePath,
          npmNode: record.npmNode === nodePath, bun: record.bun === bun }); return null
      }
      const vector = record.path.map(part => part === '<package>/node_modules/.bin' ? join(root, 'node_modules/.bin') : part)
      // Ancestor bin coordinates remain exact external PATH inputs. Their
      // presence is not installation evidence. They may not supply any member
      // of the first-party launcher's measured executable closure below.
      if (JSON.stringify(vector) !== JSON.stringify(prospectivePath)) return null
      const tools = await measureTools(vector)
      if (!tools || JSON.stringify(tools) !== JSON.stringify(admittedTools)) return null
      const version = await spawnCapture([bun, '--version'], probe, HOST_SUITE_ENV, 5000)
      const nodeVersion = await spawnCapture([node, '--version'], probe, HOST_SUITE_ENV, 5000)
      if (!version.ok || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\n?$/.test(version.stdout)
        || !nodeVersion.ok || !/^v\d+\.\d+\.\d+\n?$/.test(nodeVersion.stdout)) return null
      observations.push(digest(JSON.stringify(['bun-linux-system-selector-v1', record, tools, version.stdout.trim(), nodeVersion.stdout.trim()])))
    } finally { await rm(probe, { recursive: true, force: true }) }
  }
  return observations[0] === observations[1] ? observations[0]! : null
}

/** Only commands whose launcher closure the host knows can carry portable proof.
 * An identical command string does not measure an arbitrary external runtime. */
async function portableCommandTools(worktree: string, command?: string): Promise<string[] | null> {
  if (!command) return null
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('BASH_FUNC_') || name === 'NEUTRON_BUN_BIN'
      || ['NODE_OPTIONS', 'BUN_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(name)
      || name.startsWith('DYLD_')) return null
    if (name.startsWith('NEUTRON_TEST_') && (!PORTABLE_RUNNER_TUNING.has(name) || !/^\d+$/.test(value ?? ''))) return null
  }
  const lines = command.split('\n')
  const executable = lines.pop()
  for (const line of lines) {
    const match = /^export (NEUTRON_TEST_[A-Z_]+)=([0-9]+)$/.exec(line)
    if (!match || !PORTABLE_RUNNER_TUNING.has(match[1]!)) return null
  }
  if (executable === 'bun test') return []
  if (executable !== 'bash scripts/run-tests.sh' && executable !== 'bun run test') return null
  for (const path of PORTABLE_RUNNER_FILES) {
    if (!(await readFile(join(worktree, path))).equals(await readFile(join(hostDirectory, path)))) return null
  }
  const identities: string[] = []
  if (executable === 'bun run test') {
    const launcher = await bunPackageLauncherIdentity(worktree, command)
    if (!launcher) return null
    identities.push(launcher)
  }
  for (const name of PORTABLE_RUNNER_TOOLS) {
    const path = Bun.which(name, { PATH: process.env.PATH ?? '' })
    if (!path && name !== 'sysctl' && name !== 'nproc') return null
    identities.push(digest(JSON.stringify([name, path ? await toolContentIdentity(path) : null])))
  }
  return identities
}
/** Cache only a host tool whose complete inode signature is unchanged. Reads
 * retain ctime and inode checks; only the portable digest omits that metadata. */
async function toolContentIdentity(path: string): Promise<string> {
  const actual = await realpath(path)
  const handle = await open(actual, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw Error('nonregular-tool')
    const signature = (value: typeof before) => JSON.stringify([actual, value.dev, value.ino,
      value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String))
    const key = signature(before)
    let content = toolDigests.get(key)
    if (!content) {
      const hash = createHash('sha256')
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes)
      content = hash.digest('hex')
    }
    if (signature(await handle.stat({ bigint: true })) !== key
      || signature(await lstat(actual, { bigint: true })) !== key) throw Error('tool-changed')
    if (toolDigests.size > 64) toolDigests.clear()
    toolDigests.set(key, content)
    return digest(JSON.stringify([actual, String(before.mode), content]))
  } finally { await handle.close() }
}

async function portableSuiteIdentity(worktree: string, revision: string, bun: string,
  measured: { installed?: string; resolution?: string; covered?: string[] }, environment: string,
  command?: string): Promise<string | undefined> {
  try {
    if (!measured.installed || measured.installed === 'nonportable' || !measured.resolution || !measured.covered) return undefined
    const commandTools = await portableCommandTools(worktree, command)
    if (!commandTools) return undefined
    // A clean tracked symlink/gitlink can still read mutable external data.
    // This first portable contract admits ordinary tracked files only.
    const tracked = await spawnCapture(['git', 'ls-files', '--stage', '-z'], worktree)
    if (!tracked.ok || tracked.stdout.split('\0').filter(Boolean)
      .some(entry => !/^(100644|100755) [a-f0-9]{40,64} 0\t/.test(entry))) return undefined
    // Bun loads project test preloads before discovery. An unchanged config can
    // name mutable external code, so only the known first-party config belongs
    // to this portable contract, with each preload a confined tracked file.
    const bunfig = join(worktree, 'bunfig.toml')
    if (await exists(bunfig)) {
      const known = await readFile(join(hostDirectory, 'bunfig.toml'))
      if (!(await readFile(bunfig)).equals(known)) return undefined
      const parsed = Bun.TOML.parse(known.toString()) as { test?: { preload?: unknown } }
      const preloads = parsed.test?.preload
      if (!Array.isArray(preloads) || !preloads.every(path => typeof path === 'string' && path.startsWith('./'))) return undefined
      const root = await realpath(worktree)
      const trackedPaths = new Set(tracked.stdout.split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\t') + 1)))
      for (const preload of preloads) {
        const path = resolve(root, preload)
        if (!path.startsWith(`${root}${sep}`) || !trackedPaths.has(path.slice(root.length + 1))
          || !(await lstat(path)).isFile() || await realpath(path) !== path) return undefined
      }
    }
    // Ignored dotenv, generated artifacts and other unmeasured suite inputs
    // cannot become invisible merely because git reports a clean checkout.
    const ignored = await spawnCapture(['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], worktree)
    if (!ignored.ok || ignored.stdout.length > 16 * 1024 * 1024) return undefined
    const supplemental = new Set<string>()
    for (const path of ignored.stdout.split('\0').filter(Boolean)) {
      if (measured.covered.some(base => path === base || path.startsWith(`${base}/`))) continue
      const parts = path.split('/'), modulesIndex = parts.indexOf('node_modules')
      if (modulesIndex < 0) return undefined
      supplemental.add(parts.slice(0, modulesIndex + 1).join('/'))
    }
    // Bun also creates workspace-local node_modules links. They may resolve
    // into the already measured root store but their own declared targets and
    // permissions still need evidence. Keep this out of installation identity.
    const additional: [string, string[]][] = []
    const root = await realpath(worktree)
    const deadline = performance.now() + PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS
    for (const base of [...supplemental].sort()) {
      const fields = await installedEntries(root, [join(root, base)], deadline, spawnCapture)
      for (let index = 0; index < fields.length; index += 12) {
        if (performance.now() >= deadline) return undefined
        const path = fields[index]!, kind = fields[index + 7]!
        const entry = [fields[index + 3]!, kind, fields[index + 8]!, fields[index + 9]!, fields[index + 10]!, fields[index + 11]!]
        if (kind === 'l') {
          if (entry[2]!.startsWith('/')) return undefined
          const target = await realpath(path)
          if (!target.startsWith(`${root}${sep}`)) return undefined
          const relative = target.slice(root.length + 1)
          if (![...measured.covered, ...supplemental].some(base => relative === base || relative.startsWith(`${base}/`))) return undefined
          entry.push(relative)
        }
        additional.push([path.slice(root.length + 1), entry])
      }
    }
    if (performance.now() >= deadline) return undefined
    additional.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const tools: string[] = []
    for (const name of ['bash', 'git', 'python3']) {
      const path = Bun.which(name, { PATH: process.env.PATH ?? '' })
      if (!path) return undefined
      tools.push(await toolContentIdentity(path))
    }
    tools.push(await toolContentIdentity(bun), await toolContentIdentity(process.execPath))
    const runner = createHash('sha256')
    for (const path of [...PORTABLE_RUNNER_FILES, 'trident/host-suite.ts', 'trident/lane-processes.py', 'trident/git-mode.ts', 'open/wiring/project-build.ts',
      'open/wiring/project-build-dependencies.ts', 'open/wiring/project-build-installed-tree.py', 'scripts/ci/verify-workspace-deps.ts']) {
      runner.update(path).update(await readFile(join(hostDirectory, path)))
    }
    if (environment !== executionEnvironmentIdentity()) return undefined
    return digest(JSON.stringify(['portable-suite-v1', 'controlled-shell-v1', command, commandTools, revision, measured.installed, measured.resolution, additional,
      process.platform, process.arch, release(), hostname(), process.version, Bun.version,
      process.getuid?.(), process.getgid?.(), process.getgroups?.().sort((a, b) => a - b), process.umask(),
      tools, runner.digest('hex'), environment]))
  } catch { return undefined }
}

function executionEnvironmentIdentity(): string {
  // Only the digest leaves this function; environment values can be credentials.
  return digest(JSON.stringify(Object.entries({ ...process.env, ...HOST_SUITE_ENV })
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
}

/** Fresh host measurement for suite reuse. Unknown or dirty inputs never reuse
 * proof. This shares preparation's manifest/toolchain and local-resolution keys. */
export async function projectSuiteIdentity(worktree: string, expectedHead?: string): Promise<string | null> {
  return (await projectSuiteIdentityMeasurement(worktree, expectedHead))?.identity ?? null
}

/** The aggregate and its diagnostic components come from one measurement. */
export async function projectSuiteIdentityMeasurement(worktree: string, expectedHead?: string,
  command?: string): Promise<SuiteIdentityMeasurement | null> {
  const started = performance.now()
  let probe = 'revision'
  const refuse = (reason: string): null => {
    log.warn('suite_identity_unavailable', { workspace: digest(worktree), probe, reason,
      elapsed_ms: Math.round(performance.now() - started) })
    return null
  }
  try {
    const environment = executionEnvironmentIdentity()
    const revision = await spawnCapture(['git', 'rev-parse', '--verify', 'HEAD'], worktree)
    if (!revision.ok) return refuse('unreadable')
    if (expectedHead !== undefined && revision.stdout.trim() !== expectedHead) return refuse('head-mismatch')
    probe = 'git-status'
    const clean = await spawnCapture(['git', 'status', '--porcelain', '--untracked-files=all'], worktree)
    if (!clean.ok) return refuse('unreadable')
    if (clean.stdout.trim()) return refuse('dirty')
    probe = 'runtime'
    const executable = Bun.which('bun', { PATH: process.env.PATH ?? '' })
    if (!executable) return refuse('missing-executable')
    const bun = await realpath(executable)
    probe = 'manifest'
    const manifestPath = join(worktree, 'package.json')
    const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {}
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? []
    if (!Array.isArray(workspaces)) return refuse('invalid-workspaces')
    probe = 'preparation'
    const key = await preparationKey(worktree, workspaces, bun)
    if (!key) return refuse('unavailable')
    probe = 'resolution'
    const portable: { installed?: string; resolution?: string; covered?: string[] } = {}
    const resolution = await resolutionKey(worktree, workspaces, bun, portable)
    if (await exists(manifestPath) && !resolution) return refuse('unavailable')
    probe = 'installed-tree'
    const installed = await projectInstalledTreeIdentity(worktree, spawnCapture, portable)
    // Repositories without a manifest have no package resolution contract.
    if (!installed) return refuse('unavailable')
    probe = 'installation'
    const modules = join(worktree, 'node_modules')
    let installation = null
    if (await exists(modules)) {
      const stat = await lstat(modules)
      if (!stat.isDirectory()) return refuse('modules-not-directory')
      installation = [stat.dev, stat.ino]
    } else if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0) return refuse('missing-dependencies')
    probe = 'workspace'
    const workspace = await lstat(await realpath(worktree))
    const identity = createHash('sha256').update(JSON.stringify([key, resolution, installed, installation,
      workspace.dev, workspace.ino])).digest('hex')
    log.info('suite_identity_measured', { workspace: digest(worktree), identity, preparation: key,
      resolution, installed, installation: digest(JSON.stringify(installation)),
      workspace_identity: digest(JSON.stringify([workspace.dev, workspace.ino])),
      elapsed_ms: Math.round(performance.now() - started) })
    const portableIdentity = await portableSuiteIdentity(worktree, revision.stdout.trim(), bun, portable, environment, command)
    return { identity, ...(portableIdentity ? { portableIdentity } : {}), components: { preparation: key, resolution: resolution ?? digest('null'),
      installed: installed === 'absent' ? digest('absent') : installed,
      installation: digest(JSON.stringify(installation)),
      workspace: digest(JSON.stringify([workspace.dev, workspace.ino])) } }
  } catch { return refuse('filesystem-or-process-error') }
}

/** Provision declared Bun workspaces. Recovery can reuse a measured installation
 * only after checking the same inputs and running the host readiness verifier. */
export async function prepareProjectDependencies(worktree: string, state: string,
  run: typeof spawnCapture = spawnCapture,
  measureAvailableBytes: typeof projectInstallAvailableBytes = projectInstallAvailableBytes): Promise<void> {
  const receiptPath = join(state, 'dependencies-receipt.json')
  const invalidate = async () => { try { await unlink(receiptPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } }
  let receipt: { version?: number; key?: string; resolution?: string; modulesDevice?: number; modulesInode?: number } | null = null
  if (await exists(receiptPath) && (await lstat(receiptPath)).isFile()) {
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) } catch { /* Corrupt means reinstall. */ }
  }
  // Retire the old success before any fallible preparation, including manifest
  // parsing. A crash or timeout cannot leave that success reusable next time.
  await invalidate()
  const manifestPath = join(worktree, 'package.json')
  if (!await exists(manifestPath)) return
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages
  if (!Array.isArray(workspaces) || workspaces.length === 0) return
  const manager = typeof manifest.packageManager === 'string' ? manifest.packageManager : ''
  if (manager && !manager.startsWith('bun@')) return
  if (!manager.startsWith('bun@') && !await exists(join(worktree, 'bun.lock'))
    && !await exists(join(worktree, 'bun.lockb'))) return

  const log = join(state, 'dependencies.log')
  await appendFile(log, '\nPreparing worktree-local Bun dependencies\n', { mode: 0o600 })
  const refuse = async (detail: string): Promise<never> => {
    await invalidate()
    await appendFile(log, `REFUSED: ${detail}\n`)
    throw new Error(`Build dependency preparation failed: ${detail}; see ${log}`)
  }
  const modules = join(worktree, 'node_modules')
  if (await exists(modules) && !(await lstat(modules)).isDirectory()) {
    await refuse('node_modules must be a worktree-local directory')
  }
  const store = join(modules, '.bun')
  if (await exists(store) && !(await lstat(store)).isDirectory()) {
    await refuse('Bun store must be a worktree-local directory')
  }
  const executable = Bun.which('bun', { PATH: process.env.PATH ?? '' })
  if (!executable) return refuse('Bun executable is unavailable')
  const bun = await realpath(executable)
  const verifier = join(worktree, 'scripts', 'ci', 'verify-workspace-deps.ts')
  // Repositories without the host readiness contract still install every time.
  const key = await exists(verifier) ? await preparationKey(worktree, workspaces, bun) : null
  let reuse = false
  if (key && receipt && await exists(modules)) {
    const identity = await lstat(modules)
    reuse = receipt.version === RECEIPT_VERSION && receipt.key === key
      && receipt.modulesDevice === identity.dev && receipt.modulesInode === identity.ino
    if (reuse) reuse = typeof receipt.resolution === 'string' && receipt.resolution === await resolutionKey(worktree, workspaces, bun)
  }
  const execute = async (argv: string[], label: string, cwd = worktree) => {
    await appendFile(log, `${label}\n`)
    // exec makes the bounded host child the installer itself. Its transcript goes
    // straight to disk, and installation never borrows the publisher's credentials.
    const result = await run(['bash', '-c', `exec ${argv.map(quote).join(' ')} >>${quote(log)} 2>&1`],
      cwd, undefined, PROJECT_DEPENDENCIES_TIMEOUT_MS)
    await appendFile(log, `${label}: exit=${result.exit_code}; timed_out=${result.timed_out === true}\n`)
    if (!result.ok || result.exit_code !== 0 || result.timed_out) await refuse(`${label} did not complete successfully`)
  }
  // This host preparation phase must not execute package lifecycle scripts.
  // A project requiring generated artifacts still has to satisfy its full suite.
  if (reuse) await appendFile(log, 'Reusing validated worktree dependency receipt\n')
  else {
    let available: bigint | null = null
    try { available = await measureAvailableBytes(worktree) } catch { /* Unknown refuses admission. */ }
    if (typeof available !== 'bigint' || available < 0n) {
      await refuse('available disk space is unknown; dependency install paused')
    }
    if (available! < PROJECT_INSTALL_RESERVE_BYTES) {
      await refuse(`available disk space ${available} bytes is below the 5 GiB reserve; dependency install paused`)
    }
    await execute([bun, 'install', '--frozen-lockfile', '--ignore-scripts'], 'bun install')
  }
  // A zero exit is insufficient: a no-op executable must not admit workers into
  // the same empty tree that caused the publication failure.
  if (!await exists(modules) || !(await lstat(modules)).isDirectory() || (await readdir(modules)).length === 0) {
    await refuse('bun install produced no worktree-local dependencies')
  }
  if (await exists(store) && !(await lstat(store)).isDirectory()) {
    await refuse('Bun store must be a worktree-local directory')
  }
  // A repository carrying this verifier opts into the workspace readiness contract.
  // Both the script AND its runtime configuration must belong to the host.
  // A worktree cwd lets bunfig.toml preload branch code before even an absolute
  // host script. Keep that tree as data only, with an explicit empty config and
  // no dotenv loading; resolution inside the verifier still uses its root arg.
  if (await exists(verifier)) await execute([bun, '--config=/dev/null', '--no-env-file', hostVerifier, worktree],
    'workspace dependency verification', hostDirectory)
  // A successful installer must not silently change an input behind the receipt.
  if (key && key === await preparationKey(worktree, workspaces, bun)) {
    const resolution = await resolutionKey(worktree, workspaces, bun)
    if (!resolution) {
      await appendFile(log, 'Dependency resolutions are not confined to this worktree; preparation will not be reused\n')
      await appendFile(log, 'Worktree-local dependency preparation completed without a reusable receipt\n')
      return
    }
    const identity = await lstat(modules)
    const temporary = `${receiptPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: RECEIPT_VERSION, key, resolution,
      modulesDevice: identity.dev, modulesInode: identity.ino }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, receiptPath)
  }
  await appendFile(log, 'Worktree-local dependency preparation completed\n')
}
