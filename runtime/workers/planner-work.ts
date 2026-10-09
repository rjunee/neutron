import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
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
  description: 'Closed host operations for one admitted planner. Pass its secret capability and exact run_id/step_id. Operations: brief; list {path} (empty path lists root); read {path} or {resource:"brief"|"context"|"state",pointer?:string[]} with optional offset,limit,sha256; find {path,query} for literal matches; state; write {path,content}; probe {path,kind:"syntax"|"json",uncertainty}; publish {payload} or {blocked}. Paths are relative to the assigned worktree. No commands, tests, scripts, configs or plugins execute. brief returns a manifest: read resource brief completely once and select context fields (including committedPlan) by pointer. Read/find offsets count UTF-16 code units; pass the returned sha256 for every nonzero offset. Follow nextOffset until null when the full value is needed. state returns descriptors; read resource state for complete head/diff/preparation. Writes remain uncommitted.',
  input_schema: { type: 'object', required: ['run_id', 'step_id', 'capability', 'operation'], additionalProperties: false,
    properties: { run_id: { type: 'string' }, step_id: { type: 'string' }, capability: { type: 'string' }, operation: { enum: ['brief', 'list', 'read', 'find', 'state', 'write', 'probe', 'publish'] },
      path: { type: 'string' }, resource: { enum: ['brief', 'context', 'state'] }, pointer: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 12000 }, sha256: { type: 'string' }, query: { type: 'string' }, content: { type: 'string' }, kind: { enum: ['syntax', 'json'] }, uncertainty: { type: 'string' },
      payload: { type: 'object' }, blocked: { type: 'string' } } },
}

type Session = object
type Operation = (args: unknown) => Promise<unknown>
interface GrantControl { session: Session; request: BoundedWorkRequest; retired: boolean; ready: Promise<void>; initialized(): void; chain: Promise<unknown> }
const bindings = new WeakMap<Session, Map<string, { capability: string; operation: Operation; control: GrantControl }>>()
const constructingAndLive = new Map<string, Set<GrantControl>>()
const retiredRequests = new Set<string>()
const requestKey = (request: BoundedWorkRequest) => JSON.stringify(request)
const forgetControl = (control: GrantControl) => {
  const identity = requestKey(control.request), grants = constructingAndLive.get(identity)
  grants?.delete(control)
  if (grants?.size === 0) constructingAndLive.delete(identity)
}

/** Process-local barrier includes grants still being constructed. The durable
 * scope/run/step tombstone must precede this call and guards future processes. */
export async function retirePlannerWork(request: BoundedWorkRequest): Promise<void> {
  const identity = requestKey(request)
  retiredRequests.add(identity)
  const grants = [...constructingAndLive.get(identity) ?? []]
  for (const control of grants) control.retired = true
  await Promise.all(grants.map(async control => {
    await control.ready
    await control.chain
    const owned = bindings.get(control.session)
    if (owned?.get(key(request.run_id, request.step_id))?.control === control) owned.delete(key(request.run_id, request.step_id))
    forgetControl(control)
  }))
}

const key = (run: string, step: string) => JSON.stringify([run, step])
export async function dispatchPlannerWork(session: Session, args: unknown): Promise<unknown> {
  if (!record(args) || typeof args.run_id !== 'string' || typeof args.step_id !== 'string') throw Error('Planner operation identity required')
  const grant = bindings.get(session)?.get(key(args.run_id, args.step_id))
  if (!grant || grant.control.retired || typeof args.capability !== 'string' || args.capability !== grant.capability) throw Error('Planner has no current host operation grant')
  return grant.operation(args)
}
export function releasePlannerWork(session: Session, request: BoundedWorkRequest): void {
  const owned = bindings.get(session)
  const grant = owned?.get(key(request.run_id, request.step_id))
  if (grant) {
    grant.control.retired = true
    fireAndForget('planner-work.release-grant', grant.control.chain.finally(() => forgetControl(grant.control)))
    owned!.delete(key(request.run_id, request.step_id))
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const MAX_BYTES = 1024 * 1024

// Budget both JSON encodings used by the native text-block bridge, leaving room
// for its envelope. Pages never depend on inaccessible native persisted output.
const OUTPUT_BYTES = 14 * 1024
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value, null, 2)))
const asText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null'
const descriptor = (text: string) => ({ total: text.length, sha256: digest(text) })
const splitSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)
function readOffset(text: string, raw: Record<string, unknown>): number {
  const offset = raw.offset ?? 0
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > text.length || splitSurrogate(text, Number(offset))) throw Error('Invalid planner offset')
  if ((offset !== 0 && raw.sha256 === undefined) || (raw.sha256 !== undefined && raw.sha256 !== digest(text))) throw Error('Planner source changed or page digest missing; restart at offset zero')
  return Number(offset)
}
function page(text: string, raw: Record<string, unknown>) {
  const offset = readOffset(text, raw), limit = raw.limit ?? 12000
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 12000) throw Error('Invalid planner page limit')
  const metadata = descriptor(text)
  const result = (end: number) => ({ ...metadata, offset, content: text.slice(offset, end), nextOffset: end < text.length ? end : null })
  let low = offset, high = Math.min(text.length, offset + Number(limit))
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encodedBytes(result(middle)) <= OUTPUT_BYTES) low = middle
    else high = middle - 1
  }
  if (splitSurrogate(text, low)) low--
  if (low === offset && offset < text.length) throw Error('Planner page limit splits a Unicode character; use a larger limit')
  return result(low)
}
function selectResource(value: unknown, pointer: unknown): unknown {
  if (pointer === undefined) return value
  if (!Array.isArray(pointer) || pointer.length > 16 || pointer.some(key => typeof key !== 'string')
    || pointer.join('').length > 1024) throw Error('Invalid planner resource pointer')
  for (const key of pointer as string[]) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Unknown planner resource field')
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** Constructed only by the admitted native dispatch owner, never from tool arguments.
 * Expiry revokes operations, NOT the durable child lease or its unknown outcome. */
interface PlannerWorkInput {
  session: Session; request: BoundedWorkRequest; deadline: number; signal: AbortSignal
  base: string; pr: unknown; brief: string; context: unknown
  current(): boolean | Promise<boolean>
  validate(envelope: unknown): boolean
}
export async function bindPlannerWork(input: PlannerWorkInput): Promise<string> {
  const request = structuredClone(input.request), identity = requestKey(request)
  if (retiredRequests.has(identity)) throw Error('Planner authority retired')
  let initialized!: () => void
  const ready = new Promise<void>(resolve => { initialized = resolve })
  const control: GrantControl = { session: input.session, request, retired: false, ready, initialized, chain: Promise.resolve() }
  const grants = constructingAndLive.get(identity) ?? new Set<GrantControl>()
  grants.add(control); constructingAndLive.set(identity, grants)
  try { return await constructPlannerWork({ ...input, request, get deadline() { return input.deadline } }, control) }
  catch (error) { forgetControl(control); throw error }
  finally { control.initialized() }
}
async function constructPlannerWork(input: PlannerWorkInput, control: GrantControl): Promise<string> {
  const request = input.request
  if (!requiresPlannerWork(request) || !request.writable || request.network || !/^[0-9a-f]{40,64}$/.test(input.base)) throw Error('Invalid planner grant')
  const root = await realpath(request.cwd)
  const rootStat = await lstat(root)
  if (root !== resolve(request.cwd) || !rootStat.isDirectory()) throw Error('Planner worktree must be canonical')
  const resultDir = await realpath(dirname(request.result.path))
  if (resultDir !== dirname(request.result.path) || resultDir === root || resultDir.startsWith(root + '/')) throw Error('Planner result must be host-owned outside its writable tree')
  let terminal = false
  const writes = new Map<string, string>()
  const active = async () => {
    if (control.retired || terminal || input.signal.aborted || Date.now() >= input.deadline) throw Error('Planner operation grant expired or lost ownership')
    const current = await input.current()
    // Waiting for a sibling proof grants no fresh budget and cannot outlive
    // cancellation, termination or loss of this operation's original authority.
    if (control.retired || terminal || input.signal.aborted || Date.now() >= input.deadline || !current) throw Error('Planner operation grant expired or lost ownership')
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
    const fields: Record<string, readonly string[]> = { brief: [], list: ['path'], read: ['path', 'resource', 'pointer', 'offset', 'limit', 'sha256'], find: ['path', 'query', 'offset', 'sha256'], state: [], write: ['path', 'content'], probe: ['path', 'kind', 'uncertainty'], publish: ['payload', 'blocked'] }
    if (typeof raw.operation !== 'string' || !Object.hasOwn(fields, raw.operation)
      || Object.keys(raw).some(k => !['run_id', 'step_id', 'capability', 'operation', ...fields[raw.operation as string]!].includes(k))) throw Error('Unsupported planner operation')
    if (raw.operation === 'brief') {
      const context = record(input.context) ? input.context : {}
      return { planner: context.planner, executionStrategy: context.executionStrategy,
        brief: { resource: 'brief', ...descriptor(input.brief) },
        context: { resource: 'context', fields: Object.keys(context) },
        instructions: 'Read resource brief completely once. Select relevant context fields with pointer, including committedPlan for continuation. Full state is available as resource state. Pages have nextOffset and require sha256 after offset zero.' }
    }
    if (raw.operation === 'read' || raw.operation === 'find') {
      let text: string
      if (raw.resource !== undefined) {
        if (raw.operation !== 'read' || raw.path !== undefined || !['brief', 'context', 'state'].includes(String(raw.resource))) throw Error('Choose one planner path or host resource')
        const value = raw.resource === 'brief' ? input.brief : raw.resource === 'context' ? input.context : await snapshot()
        text = asText(selectResource(value, raw.pointer))
      } else {
        if (raw.pointer !== undefined) throw Error('Planner pointer requires a host resource')
        const path = await scopedPath(raw.path, false)
        if ((await lstat(path)).size > MAX_BYTES) throw Error('Planner read exceeds file limit')
        text = await readFile(path, 'utf8')
        if (Buffer.byteLength(text) > MAX_BYTES) throw Error('Planner read exceeds file limit')
      }
      if (raw.operation === 'read') return page(text, raw)
      if (typeof raw.query !== 'string' || !raw.query || raw.query.length > 1024) throw Error('Planner find requires a bounded literal query')
      let offset = readOffset(text, raw)
      const matches: { offset: number; line: number }[] = []
      while (matches.length < 32) {
        const found = text.indexOf(raw.query, offset)
        if (found < 0) return { ...descriptor(text), matches, nextOffset: null }
        matches.push({ offset: found, line: text.slice(0, found).split('\n').length })
        offset = found + raw.query.length
      }
      return { ...descriptor(text), matches, nextOffset: offset < text.length ? offset : null }
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
    if (raw.operation === 'state') {
      const measured = await snapshot()
      return { head: measured.head, pr: measured.pr,
        diff: { resource: 'state', pointer: ['diff'], ...descriptor(measured.diff) },
        preparation: { resource: 'state', pointer: ['preparation'], count: measured.preparation.length, ...descriptor(asText(measured.preparation)) } }
    }
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
  const serialize: Operation = args => { const result = control.chain.then(() => perform(args)); control.chain = result.catch(() => {}); return result }
  // Async construction may overlap retirement; no capability is installed from
  // a stale authorization result, even when its filesystem/Git preparation passed.
  await active()
  if (control.retired || retiredRequests.has(requestKey(request))) throw Error('Planner authority retired')
  const owned = bindings.get(input.session) ?? new Map<string, { capability: string; operation: Operation; control: GrantControl }>()
  if (owned.has(key(request.run_id, request.step_id))) throw Error('Planner operation grant already bound')
  const capability = randomBytes(32).toString('hex')
  owned.set(key(request.run_id, request.step_id), { capability, operation: serialize, control }); bindings.set(input.session, owned)
  return capability
}
