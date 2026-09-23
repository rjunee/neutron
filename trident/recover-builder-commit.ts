import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { BuildSnapshot, GateResult } from './build-run.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'
import { TRIDENT_SCRIPT_DIR } from './script-dir.ts'

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const trailer = /^claude-session:/i
export const BUILDER_COMMIT_RECOVERY = 'build-commit-recovery'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const objectId = (raw: Buffer, length: number) => createHash(length === 64 ? 'sha256' : 'sha1')
  .update(`commit ${raw.length}\0`).update(raw).digest('hex')
type Recovery = { kind: 'known'; head: string; recovered?: true } | Exclude<GateResult, { kind: 'allow' }>

/** Read projection only: the original worker envelope remains immutable. The
 * completion checkpoint must still be checked by the consuming artifact reader.
 */
export function recoveredBuildArtifact(text: string, head: string,
  events: readonly { stage: string; meta: string | null }[]): string {
  const envelope = JSON.parse(text)
  let recoveryRequired = false
  for (const event of events) {
    if (event.stage !== BUILDER_COMMIT_RECOVERY || !event.meta) continue
    const receipt = JSON.parse(event.meta)
    if (receipt.to !== head) continue
    recoveryRequired = true
    if (!oid.test(head) || receipt.from !== envelope?.result?.head
      || receipt.from !== envelope?.result?.payload?.commitSha || receipt.step !== envelope.step_id
      || receipt.run !== envelope.run_id || receipt.artifact !== digest(text)) continue
    return JSON.stringify({ ...envelope, result: { ...envelope.result, head,
      payload: { ...envelope.result.payload, commitSha: head } } })
  }
  if (!recoveryRequired && envelope?.result?.head === head) return text
  throw new Error('Completed artifact has no matching host commit recovery receipt')
}

/** Recover only one unsigned direct child produced by this completed request.
 * Raw bytes are authenticated against Git's OID before interpretation; the
 * complete header block is retained byte-for-byte. No ancestor is rewritten.
 * A durable intent precedes CAS so the same pending worker can recover a crash
 * after the swap without redispatch or relabelling its original result file.
 */
export async function recoverBuilderCommit(input: {
  runHost: EnvCapableHostRunner; repo: string; branch: string; request: BoundedWorkRequest
  before: string; measured: BuildSnapshot; result: unknown
  record: (meta: string) => Promise<void>
  events: readonly { stage: string; meta: string | null }[]
}): Promise<Recovery> {
  const { runHost, repo, branch, request, measured, before } = input
  const unknown = (detail: string): Recovery => ({ kind: 'unknown', detail: `Builder commit recovery: ${detail}` })
  const blocked = (on: string): Recovery => ({ kind: 'blocked', on: `Builder commit recovery: ${on}` })
  const result = input.result as { head?: unknown; pr?: unknown; payload?: { commitSha?: unknown; branch?: unknown } } | null
  // Preserve ordinary claim-resolution semantics. No permission to rewrite is
  // inferred from an absent, abbreviated or differently claimed revision.
  if (!result || typeof result.head !== 'string' || !oid.test(result.head)) return { kind: 'known', head: measured.head }
  const from = result.head
  let directory: string | undefined
  try {
    if (measured.head !== from) {
      // Only our durable intent can explain movement before a recovered pending
      // request. All ordinary disagreements keep the existing claim gate.
      try { recoveredBuildArtifact(await readFile(request.result.path, 'utf8'), measured.head, input.events) }
      catch { return { kind: 'known', head: measured.head } }
    }
    directory = await mkdtemp(join(tmpdir(), 'trident-commit-recovery-'))
    const rawPath = join(directory, 'object')
    // A file carries bytes across runners that trim/decode stdout. The hash
    // below proves the capture is the exact object, including non-UTF-8 bytes.
    const read = await runHost(['bash', '-c', 'git --no-replace-objects -C "$1" cat-file commit "$2" > "$3"',
      'read-builder-object', repo, from, rawPath], repo)
    if (!read.ok || read.timed_out) return unknown('raw commit could not be read')
    const raw = await readFile(rawPath)
    if (objectId(raw, from.length) !== from) return unknown('raw commit identity could not be authenticated')
    const split = raw.indexOf('\n\n')
    if (split < 0) return unknown('raw commit has no message boundary')
    const message = raw.subarray(split + 2).toString('latin1')
    const lines = message.split('\n').map((line, index, parts) => line + (index < parts.length - 1 ? '\n' : ''))
    if (!lines.some(line => trailer.test(line))) return { kind: 'known', head: measured.head }
    if ((request.role !== 'build' && request.role !== 'fix') || !request.writable
      || !oid.test(before) || from === before || result.payload?.commitSha !== from
      || result.payload?.branch !== branch || !isDeepStrictEqual(result.pr, measured.pr)) return blocked('completed worker identity does not authorize a rewrite')
    const validRef = await runHost(['git', '-C', repo, 'check-ref-format', `refs/heads/${branch}`], repo)
    if (!validRef.ok || validRef.timed_out) return blocked('assigned branch is not a valid direct ref name')
    const headers = raw.subarray(0, split).toString('latin1').split('\n')
    const parents = headers.filter(line => line.startsWith('parent '))
    if (parents.length !== 1 || parents[0] !== `parent ${before}`) return blocked('commit is not the exact direct child of the worker input')
    // Signing a new object would require a new signing decision. Do not drop a
    // signature or copy an invalid one, and refuse unknown/continued headers.
    if (headers.some(line => !/^(tree|parent|author|committer|encoding) /.test(line))
      || ['tree', 'author', 'committer'].some(key => headers.filter(line => line.startsWith(`${key} `)).length !== 1)
      || headers.filter(line => line.startsWith('encoding ')).length > 1) return blocked('signed or unsupported commit headers require the commit wrapper')
    const kept = lines.filter(line => !trailer.test(line)).join('')
    if (!kept.trim()) return blocked('removing the trailer would leave an empty message')
    const candidate = Buffer.concat([raw.subarray(0, split + 2), Buffer.from(kept, 'latin1')])
    const to = objectId(candidate, from.length)
    if (measured.head !== from && measured.head !== to) return blocked('branch moved to a different commit')
    const artifact = await readFile(request.result.path, 'utf8')
    const envelope = JSON.parse(artifact)
    if (envelope?.kind !== 'completed' || envelope.schema !== request.result.schema
      || envelope.run_id !== request.run_id || envelope.step_id !== request.step_id
      || !isDeepStrictEqual(envelope.result, input.result)) return blocked('original worker artifact does not match the completed request')
    const candidatePath = join(directory, 'candidate')
    await writeFile(candidatePath, candidate, { mode: 0o600 })
    const written = await runHost(['git', '--no-replace-objects', '-C', repo, 'hash-object', '-w', '-t', 'commit', candidatePath], repo)
    if (!written.ok || written.timed_out || written.stdout.trim() !== to) return unknown('candidate object was not confirmed')
    // Read it back independently before any ref can name it.
    const verified = await runHost(['bash', '-c', 'git --no-replace-objects -C "$1" cat-file commit "$2" > "$3"',
      'read-builder-object', repo, to, rawPath], repo)
    if (!verified.ok || verified.timed_out || !(await readFile(rawPath)).equals(candidate)) return unknown('candidate bytes were not confirmed')
    await input.record(JSON.stringify({ run: request.run_id, step: request.step_id, from, to, parent: before, artifact: digest(artifact) }))
    const swap = await runHost(['bash', join(TRIDENT_SCRIPT_DIR, 'swap-builder-commit.sh'), repo,
      `refs/heads/${branch}`, to, measured.head], repo)
    if (!swap.ok || swap.timed_out) return unknown('branch compare-and-swap was not confirmed; no other revision may be rewritten')
    return { kind: 'known', head: to, recovered: true }
  } catch { return unknown('commit or worker evidence could not be read') }
  finally { if (directory) await rm(directory, { recursive: true, force: true }) }
}
