import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'

/** Host-observed launch inputs, not a catalog or proof of a tool invocation.
 * Copy into the original signed dispatch receipt before worker submission to
 * retain the observation across gateway restart. Never reconstruct from JSONL. */
export interface NativeParentLaunchEvidence {
  readonly version: 1
  readonly sessionId: string
  readonly childGeneration: string
  readonly projectId: string
  readonly executable: { readonly realPath: string; readonly sha256: string; readonly version: string }
  readonly argv: readonly string[]
  readonly tools: readonly string[]
}

const launches = new WeakMap<object, NativeParentLaunchEvidence>()
const binaries = new Map<string, NativeParentLaunchEvidence['executable']>()

export function readNativeParentLaunchEvidence(session: object): NativeParentLaunchEvidence | undefined {
  return launches.get(session)
}

/** Trusted host producer boundary, also injectable by consuming fixtures.
 * Never call with worker payloads, transcript rows, or a model tool argument. */
export function recordNativeParentLaunchEvidence(session: object, evidence: NativeParentLaunchEvidence): void {
  launches.set(session, Object.freeze({ ...evidence,
    executable: Object.freeze({ ...evidence.executable }),
    argv: Object.freeze([...evidence.argv]), tools: Object.freeze([...evidence.tools]) }))
}

function identity(path: string): string {
  const stat = statSync(path, { bigint: true })
  if (!stat.isFile()) throw new Error('Native executable is not a regular file')
  return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/** Probe failure leaves ordinary chat usable but supplies no continuation
 * authority. Cache only the same file identity; replacements require a new hash
 * and bounded version probe. Resolving argv[0] prevents a later PATH lookup
 * selecting a different binary. This does not attest the executed process image. */
export async function prepareNativeParentLaunch(input: {
  sessionId: string; childGeneration: string; projectId: string
  argv: readonly string[]; tools: readonly string[]; cwd: string
  env: Record<string, string | undefined>
}): Promise<{ argv: string[]; record(session: object): void } | undefined> {
  if (!input.projectId || !input.tools.includes('Agent') || !input.tools.includes('SendMessage')) return undefined
  try {
    const selected = Bun.which(input.argv[0]!, { cwd: input.cwd, PATH: input.env['PATH'] ?? process.env['PATH'] ?? '' })
    if (!selected) return undefined
    const realPath = realpathSync(selected)
    const before = identity(realPath)
    let executable = binaries.get(before)
    if (!executable) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(realPath)) hash.update(chunk)
      const result = spawnSync(realPath, ['--version'], { cwd: input.cwd, env: input.env,
        encoding: 'utf8', timeout: 5000, maxBuffer: 4096 })
      const version = result.stdout?.trim().match(/^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/)?.[1]
      if (result.status !== 0 || !version || before !== identity(realPath)) return undefined
      executable = Object.freeze({ realPath, sha256: hash.digest('hex'), version })
      binaries.set(before, executable)
    }
    const argv = [realPath, ...input.argv.slice(1)]
    const evidence: NativeParentLaunchEvidence = Object.freeze({ version: 1,
      sessionId: input.sessionId, childGeneration: input.childGeneration, projectId: input.projectId,
      executable, argv: Object.freeze([...argv]), tools: Object.freeze([...input.tools]) })
    return { argv, record(session) {
      // A replaced executable during spawn invalidates this observation.
      try { if (identity(realPath) === before) recordNativeParentLaunchEvidence(session, evidence) } catch { /* unknown */ }
    } }
  } catch { return undefined }
}
