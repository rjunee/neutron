import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { readNativeRequestRelay } from './native-request-relay.ts'
import type { NativeRelayScope } from '../../../workers/claude-capacity-client.ts'

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
  readonly relay?: NativeRelayScope
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

/** Measure the named file; retain the check across the caller's observation. */
export async function observeNativeExecutable(selected: string, cwd: string,
  env: Record<string, string | undefined>): Promise<{
    executable: NativeParentLaunchEvidence['executable']; isCurrent(): boolean
  } | undefined> {
  try {
    const realPath = realpathSync(selected)
    if (realPath.endsWith(' (deleted)')) return undefined
    const before = identity(selected)
    const isCurrent = () => {
      try { return realpathSync(selected) === realPath && identity(selected) === before } catch { return false }
    }
    let executable = binaries.get(before)
    if (!executable) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(selected)) hash.update(chunk)
      const result = spawnSync(selected, ['--version'], { cwd, env,
        encoding: 'utf8', timeout: 5000, maxBuffer: 4096 })
      const version = result.stdout?.trim().match(/^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/)?.[1]
      if (result.status !== 0 || !version || !isCurrent()) return undefined
      executable = Object.freeze({ realPath, sha256: hash.digest('hex'), version })
      binaries.set(before, executable)
    }
    return { executable, isCurrent }
  } catch { return undefined }
}

/** Probe failure leaves ordinary chat usable but supplies no continuation
 * authority. Cache only the same file identity; replacements require a new hash
 * and bounded version probe. Preserve configured argv: restart adoption matches
 * that launcher basename, which can differ from its symlink target. The resolved
 * file is measured separately; this does not attest the executed process image. */
export async function prepareNativeParentLaunch(input: {
  sessionId: string; childGeneration: string; projectId: string
  argv: readonly string[]; tools: readonly string[]; cwd: string
  env: Record<string, string | undefined>
}): Promise<{ argv: string[]; env: Record<string, string | undefined>; record(session: object): void } | undefined> {
  if (!input.projectId || !input.tools.includes('Agent') || !input.tools.includes('SendMessage')) return undefined
  try {
    const selected = Bun.which(input.argv[0]!, { cwd: input.cwd, PATH: input.env['PATH'] ?? process.env['PATH'] ?? '' })
    if (!selected) return undefined
    const observation = await observeNativeExecutable(selected, input.cwd, input.env)
    if (!observation) return undefined
    const argv = [...input.argv], env = input.env
    const evidence: NativeParentLaunchEvidence = Object.freeze({ version: 1,
      sessionId: input.sessionId, childGeneration: input.childGeneration, projectId: input.projectId,
      executable: observation.executable, argv: Object.freeze([...argv]), tools: Object.freeze([...input.tools]) })
    return { argv, env, record(session) {
      // A replaced executable during spawn invalidates this observation.
      try {
        if (observation.isCurrent()) {
          const relay = readNativeRequestRelay(session)
          recordNativeParentLaunchEvidence(session, { ...evidence, ...(relay ? { relay } : {}) })
        }
      } catch { /* unknown */ }
    } }
  } catch { return undefined }
}
