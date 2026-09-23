import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { placementFor, type BoundedWorkOutcome, type BoundedWorkRequest, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'

/** Host-owned conversation bindings; never worker result authority. See
 * docs/spec-items/trident-build-efficiency.md, recurring work acceptance. */
export interface ProjectWorkerContinuityOptions {
  stateDir: string
  runId: string
  projectId: string
  replProvider: Provider
  runner: WorkerRunner
  /** Stable selected account identity, or a conservative hash of credential
   * bytes when account identity cannot be attested. Never return a secret. */
  credentialIdentity(): Promise<string | null>
  /** Atomic host-owned witness outside the replaceable filesystem receipts.
   * Only the first initiation for this run and role may claim it. */
  claimInitial(request: BoundedWorkRequest, scope: string): Promise<boolean>
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const recurring = (role: string) => role === 'plan' || role === 'build' || role === 'fix'
const validThread = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(value)
const unknown = (detail: string): BoundedWorkOutcome => ({ kind: 'unknown', detail: `Worker continuity: ${detail}` })

async function read(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16_384) throw Error('invalid receipt file')
    const bytes = Buffer.alloc(16_385)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 16_384) throw Error('oversized receipt')
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally { await file.close() }
}

async function write(dir: string, name: string, value: unknown): Promise<void> {
  const temporary = join(dir, `.write-${randomUUID()}`)
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() }
  finally { await file.close() }
  await rename(temporary, join(dir, name))
  const directory = await open(dir, constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}

interface State { version: 1; scope: string; thread: string | null; pending: string | null }
interface Step { version: 1; scope: string; request: string; thread: string | null }
function state(value: unknown, scope: string): State {
  const s = value as State | null
  if (!s || s.version !== 1 || s.scope !== scope || !(s.thread === null || validThread(s.thread))
    || !(s.pending === null || typeof s.pending === 'string' && s.pending.length > 0)) throw Error('missing or corrupt binding')
  return s
}

/** Only cross-provider recurring turns receive retained-thread ownership.
 * A leftover writer lock is uncertainty, never permission to steal a thread.
 * The original runner retains step recovery and result validation authority. */
export function createProjectWorkerContinuity(options: ProjectWorkerContinuityOptions): WorkerRunner {
  const { runner } = options
  const applies = (req: BoundedWorkRequest) => recurring(req.role)
    && placementFor(runner.provider, options.replProvider) === 'headless'
  const directory = (req: BoundedWorkRequest) => join(options.stateDir, `worker-conversation-${req.role}`)
  const scope = async (req: BoundedWorkRequest): Promise<string> => {
    if (req.run_id !== options.runId) throw Error('run ownership mismatch')
    const credential = await options.credentialIdentity()
    if (!credential) throw Error('selected credential identity unavailable')
    return hash([options.runId, options.projectId, req.role, runner.provider, req.model_id, credential, req.cwd])
  }
  const stepDir = (dir: string, req: BoundedWorkRequest) => join(dir, `step-${hash(req.step_id)}`)
  // A replacement host regenerates transport filenames and its remaining wait
  // budget. The adapter's reservation directory and meaningful work stay fixed.
  const requestIdentity = (req: BoundedWorkRequest) => hash({
    run: req.run_id, step: req.step_id, role: req.role, model: req.model_id, effort: req.effort,
    cwd: resolve(req.cwd), brief: req.brief.integrity, schema: req.result.schema,
    reservationDirectory: resolve(dirname(req.result.path)),
    writable: req.writable, network: req.network, tools: req.tools, approval: req.needs_approval_decision,
  })
  const readStep = async (dir: string, req: BoundedWorkRequest, owner: string): Promise<Step> => {
    const location = stepDir(dir, req)
    if (!(await lstat(location)).isDirectory()) throw Error('step directory is not owned')
    const value = await read(join(location, 'request.json')) as Step | null
    if (!value || value.version !== 1 || value.scope !== owner || value.request !== requestIdentity(req)
      || !(value.thread === null || validThread(value.thread))) throw Error('step binding mismatch')
    return value
  }
  return {
    provider: runner.provider,
    supports: (role, placement) => runner.supports(role, placement),
    liveness: handle => runner.liveness(handle),
    async observe(req) {
      if (!applies(req)) return runner.observe?.(req)
      try {
        const owner = await scope(req)
        state(await read(join(directory(req), 'binding.json')), owner)
        const step = await readStep(directory(req), req, owner)
        if (req.thread && req.thread.id !== step.thread) return undefined
        return await runner.observe?.({ ...req, thread: step.thread === null ? null : { id: step.thread } })
      } catch { return undefined }
    },
    async run(req, placement, signal) {
      const supported = runner.supports(req.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      if (!applies(req)) return runner.run(req, placement, signal)
      if (placement !== 'headless') return { kind: 'refused', reason: 'placement-unavailable' }
      let release: (() => Promise<void>) | undefined
      try {
        const owner = await scope(req)
        const dir = directory(req)
        const lock = `${dir}.writer.lock`
        const lease = await open(lock, 'wx', 0o600)
        await lease.close()
        release = () => unlink(lock)
        const initiation = `${dir}.initiated.json`
        let initiated: unknown
        try { initiated = await read(initiation) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          // The initiation witness lives outside the replaceable role directory.
          // Losing either half never makes a previously used role fresh again.
          try { await lstat(dir); throw Error('initiation witness missing') }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
          if (!await options.claimInitial(req, owner)) throw Error('conversation was already initiated')
          initiated = { version: 1, scope: owner }
          await write(options.stateDir, `worker-conversation-${req.role}.initiated.json`, initiated)
          await mkdir(dir, { mode: 0o700 })
          await write(dir, 'binding.json', { version: 1, scope: owner, thread: null, pending: null })
        }
        if ((initiated as { version?: unknown })?.version !== 1
          || (initiated as { scope?: unknown })?.scope !== owner) throw Error('initiation ownership mismatch')
        if (!(await lstat(dir)).isDirectory()) throw Error('binding directory is not owned')
        const binding = state(await read(join(dir, 'binding.json')), owner)
        if (binding.pending !== null && binding.pending !== req.step_id) throw Error('previous step remains unresolved')
        let newStep = false
        try { await mkdir(stepDir(dir, req), { mode: 0o700 }); newStep = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        if (newStep) {
          if (binding.pending === req.step_id) throw Error('reserved step receipt missing')
          await write(stepDir(dir, req), 'request.json', {
            version: 1, scope: owner, request: requestIdentity(req), thread: binding.thread,
          })
        }
        const step = await readStep(dir, req, owner)
        if (req.thread && req.thread.id !== step.thread) throw Error('requested thread is not owned')
        await write(dir, 'binding.json', { ...binding, pending: req.step_id })
        if (await scope(req) !== owner) throw Error('credential changed before dispatch')
        const outcome = await runner.run({ ...req, thread: step.thread === null ? null : { id: step.thread } }, placement, signal)
        if (outcome.kind !== 'completed') return outcome
        if (await scope(req) !== owner) return unknown('credential changed during dispatch')
        if (!validThread(outcome.thread_id) || (binding.thread !== null && outcome.thread_id !== binding.thread)
          || (step.thread !== null && outcome.thread_id !== step.thread)) return unknown('provider did not observe the owned thread')
        await write(dir, 'binding.json', { ...binding, thread: outcome.thread_id, pending: null })
        return outcome
      } catch { return unknown('binding is unavailable, mismatched, or held by another writer') }
      finally { await release?.().catch(() => { /* An uncleared lock remains fail-closed. */ }) }
    },
  }
}
