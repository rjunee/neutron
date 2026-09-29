import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'

export const PLANNER_ROLE = 'neutron-planner-v1'
export const PLANNER_TOOL = 'planner_work'
export const PLANNER_NATIVE_TOOL = `mcp__neutron__${PLANNER_TOOL}`
/** Editing plus closed host diagnostics is not a grant to execute programs. */
export const requiresPlannerWork = (request: BoundedWorkRequest): boolean => request.role === 'plan' && request.tools === 'edit'
export const PLANNER_AGENT = {
  description: 'Host-bound writable project planning with closed diagnostics.',
  prompt: 'Use planner_work for scoped preparation, measured state, syntax/JSON diagnostics and atomic result publication. No program execution is available. Read the supplied brief and request. Preparatory writes remain uncommitted for the builder; describe them in executionSpec. Builder acceptance validation remains required.',
  tools: [PLANNER_NATIVE_TOOL],
}
export const PLANNER_PROFILE = JSON.stringify({ [PLANNER_ROLE]: PLANNER_AGENT })
export const PLANNER_PROFILE_ID = createHash('sha256').update(PLANNER_PROFILE).digest('hex')
export const PLANNER_TOOL_SCHEMA = {
  name: PLANNER_TOOL,
  description: 'Closed host operations for one admitted planner. Pass its secret capability and exact run_id/step_id. Operations: brief; list {path} (empty path lists root); read {path}; state; write {path,content}; probe {path,kind:"syntax"|"json",uncertainty}; publish {payload} or {blocked}. Paths are relative to the assigned worktree. No commands, tests, scripts, configs or plugins execute. Writes remain uncommitted; state reports them separately from committed head/diff.',
  input_schema: { type: 'object', required: ['run_id', 'step_id', 'capability', 'operation'], additionalProperties: false,
    properties: { run_id: { type: 'string' }, step_id: { type: 'string' }, capability: { type: 'string' }, operation: { enum: ['brief', 'list', 'read', 'state', 'write', 'probe', 'publish'] },
      path: { type: 'string' }, content: { type: 'string' }, kind: { enum: ['syntax', 'json'] }, uncertainty: { type: 'string' },
      payload: { type: 'object' }, blocked: { type: 'string' } } },
}

type Session = object
type Operation = (args: unknown) => Promise<unknown>
const bindings = new WeakMap<Session, Map<string, { capability: string; operation: Operation }>>()
const key = (run: string, step: string) => JSON.stringify([run, step])
export async function dispatchPlannerWork(session: Session, args: unknown): Promise<unknown> {
  if (!record(args) || typeof args.run_id !== 'string' || typeof args.step_id !== 'string') throw Error('Planner operation identity required')
  const grant = bindings.get(session)?.get(key(args.run_id, args.step_id))
  if (!grant || typeof args.capability !== 'string' || args.capability !== grant.capability) throw Error('Planner has no current host operation grant')
  return grant.operation(args)
}
export function releasePlannerWork(session: Session, request: BoundedWorkRequest): void {
  bindings.get(session)?.delete(key(request.run_id, request.step_id))
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const MAX_BYTES = 1024 * 1024

/** Constructed only by the admitted native dispatch owner, never from tool arguments.
 * Expiry revokes operations, NOT the durable child lease or its unknown outcome. */
export async function bindPlannerWork(input: {
  session: Session; request: BoundedWorkRequest; deadline: number; signal: AbortSignal
  base: string; pr: unknown; brief: string; context: unknown
  current(): boolean
  validate(envelope: unknown): boolean
}): Promise<string> {
  const request = structuredClone(input.request)
  if (!requiresPlannerWork(request) || !request.writable || request.network || !/^[0-9a-f]{40,64}$/.test(input.base)) throw Error('Invalid planner grant')
  const root = await realpath(request.cwd)
  const rootStat = await lstat(root)
  if (root !== resolve(request.cwd) || !rootStat.isDirectory()) throw Error('Planner worktree must be canonical')
  const resultDir = await realpath(dirname(request.result.path))
  if (resultDir !== dirname(request.result.path) || resultDir === root || resultDir.startsWith(root + '/')) throw Error('Planner result must be host-owned outside its writable tree')
  let terminal = false
  const writes = new Map<string, string>()
  let chain: Promise<unknown> = Promise.resolve()
  const active = async () => {
    if (terminal || input.signal.aborted || Date.now() >= input.deadline || !input.current()) throw Error('Planner operation grant expired or lost ownership')
    const now = await lstat(root)
    if (now.dev !== rootStat.dev || now.ino !== rootStat.ino || await realpath(root) !== root) throw Error('Planner worktree identity changed')
  }
  const gitBinary = Bun.which('git')
  if (!gitBinary) throw Error('Host Git unavailable')
  const git = async (args: string[]): Promise<string> => {
    await active()
    return new Promise((resolveOutput, reject) => {
      execFile(gitBinary, ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-C', root, ...args], {
        cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
        timeout: Math.max(1, Math.min(10_000, input.deadline - Date.now())), maxBuffer: MAX_BYTES, signal: input.signal,
      }, (error, stdout) => error ? reject(Error('Planner Git observation failed')) : resolveOutput(stdout))
    })
  }
  const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw Error('Planner head unreadable')
  const scopedPath = async (value: unknown, create: boolean): Promise<string> => {
    if (typeof value !== 'string' || value.length > 1024 || !value || value.includes('\\') || value.includes('\0')) throw Error('Invalid planner path')
    const parts = value.split('/')
    if (parts.some(part => !part || part.startsWith('.') || part === 'node_modules')) throw Error('Planner path is outside preparatory scope')
    let path = root
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]!)
      const last = i === parts.length - 1
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink() || (last ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw Error('Planner path aliases another object')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
        if (!last) await mkdir(path)
      }
    }
    return path
  }
  const snapshot = async () => {
    const currentHead = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    if (currentHead !== head) throw Error('Planner branch moved outside its grant')
    const diff = await git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--full-index', `${input.base}...${head}`, '--'])
    // Worktree diff/status may invoke configured clean filters. Observe only
    // committed objects through Git; preparation is measured as raw file bytes.
    const preparation = await Promise.all([...writes].map(async ([path, expected]) => {
      const sha256 = digest(await readFile(await scopedPath(path, false), 'utf8'))
      if (sha256 !== expected) throw Error('Planner preparation changed outside its grant')
      return { path, sha256, committed: false }
    }))
    return { head, diff, pr: input.pr, preparation }
  }
  const perform: Operation = async raw => {
    await active()
    if (!record(raw) || raw.run_id !== request.run_id || raw.step_id !== request.step_id) throw Error('Planner request identity mismatch')
    const fields: Record<string, readonly string[]> = { brief: [], list: ['path'], read: ['path'], state: [], write: ['path', 'content'], probe: ['path', 'kind', 'uncertainty'], publish: ['payload', 'blocked'] }
    if (typeof raw.operation !== 'string' || !Object.hasOwn(fields, raw.operation)
      || Object.keys(raw).some(k => !['run_id', 'step_id', 'capability', 'operation', ...fields[raw.operation as string]!].includes(k))) throw Error('Unsupported planner operation')
    if (raw.operation === 'brief') return { brief: input.brief, context: input.context }
    if (raw.operation === 'read') {
      const path = await scopedPath(raw.path, false)
      if ((await lstat(path)).size > MAX_BYTES) throw Error('Planner read exceeds file limit')
      return { path: raw.path, content: await readFile(path, 'utf8') }
    }
    if (raw.operation === 'list') {
      if (typeof raw.path !== 'string' || raw.path.includes('\\') || raw.path.split('/').some(part => part.startsWith('.') || part === 'node_modules')) throw Error('Invalid planner directory')
      let directory = root
      for (const part of raw.path ? raw.path.split('/') : []) {
        if (!part) throw Error('Invalid planner directory')
        directory = join(directory, part)
        if (!(await lstat(directory)).isDirectory()) throw Error('Planner directory aliases another object')
      }
      const entries = await readdir(directory, { withFileTypes: true })
      return { entries: entries.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules' && !entry.isSymbolicLink())
        .map(entry => ({ name: entry.name, directory: entry.isDirectory() })) }
    }
    if (raw.operation === 'state') return snapshot()
    if (raw.operation === 'write') {
      if (typeof raw.content !== 'string' || Buffer.byteLength(raw.content) > MAX_BYTES) throw Error('Planner write exceeds file limit')
      const path = await scopedPath(raw.path, true)
      await active()
      const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        const info = await fd.stat()
        if (!info.isFile() || info.nlink !== 1) throw Error('Planner write target changed')
        await fd.truncate(0); await fd.writeFile(raw.content)
      } finally { await fd.close() }
      writes.set(raw.path as string, digest(raw.content))
      return { written: raw.path, sha256: digest(raw.content), committed: false }
    }
    if (raw.operation === 'probe') {
      if (typeof raw.uncertainty !== 'string' || !raw.uncertainty.trim() || raw.uncertainty.length > 2000
        || !['syntax', 'json'].includes(String(raw.kind))) throw Error('A named uncertainty and closed diagnostic are required')
      const path = await scopedPath(raw.path, false)
      const source = await readFile(path, 'utf8')
      if (Buffer.byteLength(source) > MAX_BYTES) throw Error('Planner diagnostic exceeds file limit')
      const loader = /\.tsx$/.test(path) ? 'tsx' : /\.ts$/.test(path) ? 'ts' : /\.jsx$/.test(path) ? 'jsx' : /\.(?:js|mjs|cjs)$/.test(path) ? 'js' : null
      if (raw.kind === 'syntax' && !loader) throw Error('Syntax diagnostic requires one JavaScript or TypeScript file')
      let diagnostic: { ok: boolean; detail?: string } = { ok: true }
      try {
        if (raw.kind === 'json') JSON.parse(source)
        else new Bun.Transpiler({ loader: loader! }).scan(source)
      } catch (error) { diagnostic = { ok: false, detail: String(error) } }
      await active()
      const report = { path: raw.path, kind: raw.kind, uncertainty: raw.uncertainty, sha256: digest(source), ...diagnostic }
      const log = `${request.result.path}.probe-${digest(JSON.stringify(report))}.json`
      await writeFile(log, JSON.stringify(report), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      return { ...report, log }
    }
    if ((raw.blocked !== undefined) === (raw.payload !== undefined)) throw Error('Publish exactly one payload or blocked reason')
    const measured = await snapshot()
    const payload = record(raw.payload) && typeof raw.payload.executionSpec === 'string' && measured.preparation.length
      ? { ...raw.payload, executionSpec: raw.payload.executionSpec + '\nHost-observed uncommitted preparation (retain and validate in the build): ' + JSON.stringify(measured.preparation) }
      : raw.payload
    const envelope = raw.blocked !== undefined ? { schema: request.result.schema, run_id: request.run_id, step_id: request.step_id, kind: 'blocked', on: raw.blocked }
      : { schema: request.result.schema, run_id: request.run_id, step_id: request.step_id, kind: 'completed',
        result: { head: measured.head, diff: measured.diff, pr: measured.pr, payload } }
    if (!input.validate(envelope)) throw Error('Planner result contract refused publication')
    // Separate host evidence preserves uncommitted preparation without claiming it
    // was part of the committed snapshot or a substitute for builder validation.
    await writeFile(`${request.result.path}.preparation.json`, JSON.stringify(measured), { mode: 0o600 })
    await active()
    const temp = `${request.result.path}.${randomUUID()}.tmp`
    try { await writeFile(temp, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 }); await active(); await rename(temp, request.result.path) }
    finally { await unlink(temp).catch(() => {}) }
    terminal = true
    return { published: true, head, preparation: measured.preparation }
  }
  const serialize: Operation = args => { const result = chain.then(() => perform(args)); chain = result.catch(() => {}); return result }
  const owned = bindings.get(input.session) ?? new Map<string, { capability: string; operation: Operation }>()
  if (owned.has(key(request.run_id, request.step_id))) throw Error('Planner operation grant already bound')
  const capability = randomBytes(32).toString('hex')
  owned.set(key(request.run_id, request.step_id), { capability, operation: serialize }); bindings.set(input.session, owned)
  return capability
}
