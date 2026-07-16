/**
 * @neutronai/runtime — Codex CLI exec stream.
 *
 * Spawns `codex exec --json "<prompt>"` (with `--resume <id>` when resuming a
 * thread) and streams the JSONL stdout line-by-line. Each parsed envelope is
 * mapped via `event-map.ts` to a substrate `Event` and yielded. Cancellation
 * SIGTERMs the child; the `finally` block always reaps regardless of how the
 * iterator exits (caller cancel, completion, error).
 *
 * The spawn uses `node:child_process` for portability with both Bun and Node
 * test runners. Codex itself is a binary; `--json` switches stdout to JSONL.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { Event } from '../../events.ts'
import { mapCodexEvent, newCodexJsonlMapper } from './event-map.ts'

/**
 * Spawn shim — production binds to `node:child_process.spawn`. Tests inject
 * a fake that captures argv + env and returns a minimal `ChildProcessByStdio`
 * stub so the env-overlay regression suite (ISSUES #67) can pin the merged
 * env shape without depending on a real `codex` binary on PATH.
 */
export type CodexSpawnLike = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { stdio: ['ignore', 'pipe', 'pipe']; env: Record<string, string> },
) => ChildProcessByStdio<null, Readable, Readable>

export interface CodexExecOptions {
  prompt: string
  /** Codex thread id from a prior `thread.started` envelope. Triggers `--resume <id>`. */
  resume_id?: string
  /**
   * Env to merge into the spawn (`CODEX_HOME`, `OPENAI_API_KEY`, etc. — see
   * auth.ts).
   *
   * ISSUES #67 (2026-05-28) — values are typed `string | undefined`. The
   * merge in `startCodexExec` treats `undefined` as "delete from
   * parentEnv": a host-inherited Codex auth env var (e.g. a leftover
   * `OPENAI_API_KEY` from the gateway box) gets dropped from the per-spawn
   * env before the subprocess sees it. `resolveCodexAuth` uses this
   * contract to guarantee the subprocess sees ONLY the selected
   * credential's auth var, never a stale fallback that the `codex`
   * binary's auth precedence would prefer over the persisted OAuth file.
   * The per-spawn env copy is local to this call; `process.env` is
   * never mutated.
   */
  spawn_env: Record<string, string | undefined>
  /** AbortSignal — triggers SIGTERM to the child. */
  signal: AbortSignal
  /** Override the binary path. Default: `codex`. */
  bin?: string
  /** Optional model override → `--model <id>`. */
  model?: string
  /**
   * Spawn implementation. Defaults to `node:child_process.spawn`. Tests
   * inject a stub that records argv + env (a self-contained testability seam).
   */
  spawnImpl?: CodexSpawnLike
}

export async function* startCodexExec(opts: CodexExecOptions): AsyncGenerator<Event, void, void> {
  const args = ['exec', '--json']
  if (opts.resume_id) args.push('--resume', opts.resume_id)
  if (opts.model) args.push('--model', opts.model)
  args.push(opts.prompt)

  // ISSUES #67 (2026-05-28) — env merge with `undefined`-as-delete semantics.
  // Previously this was `{ ...process.env, ...opts.spawn_env }`, which leaked
  // every host env var (including a leftover `OPENAI_API_KEY` from the
  // gateway box) into the subprocess. On a `codex_oauth` instance the `codex`
  // binary's documented auth precedence would then prefer the host's
  // `OPENAI_API_KEY` over the persisted OAuth file — billing the host's
  // quota instead of the instance's credential. `resolveCodexAuth` now seeds
  // `spawn_env` with the unused Codex auth variants set to `undefined`; the
  // loop below drops those keys from the merged copy. The merged object is
  // local to this call — `process.env` is never mutated.
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') merged[k] = v
  }
  for (const [k, v] of Object.entries(opts.spawn_env)) {
    if (v === undefined) {
      delete merged[k]
    } else {
      merged[k] = v
    }
  }

  let child: ChildProcessByStdio<null, Readable, Readable>
  const spawnImpl: CodexSpawnLike = opts.spawnImpl ?? (nodeSpawn as unknown as CodexSpawnLike)
  try {
    child = spawnImpl(opts.bin ?? 'codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: merged,
    })
  } catch (err) {
    yield { kind: 'error', message: `codex spawn failed: ${(err as Error).message}`, retryable: false }
    return
  }

  // child_process.spawn surfaces "ENOENT (binary not on PATH)" / "EACCES" /
  // similar startup failures via the child's `'error'` event, NOT the
  // surrounding try/catch above. Without this listener those become
  // unhandled-process-error exceptions on the host. Capture and surface as a
  // substrate `error` event instead so operator misconfiguration produces a
  // clean, actionable failure (Codex r1 P2 finding).
  const childErrors: Error[] = []
  const onChildError = (err: Error): void => {
    childErrors.push(err)
  }
  child.on('error', onChildError)

  const onAbort = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {
      // best-effort
    }
  }
  if (opts.signal.aborted) onAbort()
  else opts.signal.addEventListener('abort', onAbort, { once: true })

  const mapper = newCodexJsonlMapper()
  const stderrChunks: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

  let buf = ''
  let completionEmitted = false
  let streamReadFailed = false
  try {
    // The 'error' event fires asynchronously on the next tick(s) for ENOENT-
    // style failures, so we briefly yield to let pending events settle before
    // committing to the for-await. This keeps the happy path fast while
    // avoiding hangs against a stillborn child whose stdout never produces.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (childErrors.length > 0) {
      yield {
        kind: 'error',
        message: `codex spawn failed: ${childErrors[0]!.message}`,
        retryable: false,
      }
      return
    }
    // The for-await on child.stdout can throw ERR_STREAM_PREMATURE_CLOSE OR
    // hang when the child dies before producing data. Race the iterator
    // against the child's 'error' / 'exit' / stdout 'close' events so a
    // stillborn child surfaces as a substrate error instead of stalling.
    const earlyClosePromise = new Promise<'closed'>((resolve) => {
      const fire = (): void => resolve('closed')
      child.once('error', fire)
      child.once('exit', fire)
      child.stdout.once('close', fire)
    })
    try {
      const iter = (child.stdout as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await Promise.race<
          { value?: Buffer; done?: boolean } | 'closed'
        >([iter.next(), earlyClosePromise])
        if (result === 'closed') {
          // Drain any remaining buffered data before bailing.
          while (true) {
            const drained = (await Promise.race([
              iter.next(),
              new Promise<{ done: true }>((resolve) =>
                setImmediate(() => resolve({ done: true })),
              ),
            ])) as { value?: Buffer; done?: boolean }
            if (drained.done) break
            if (drained.value) buf += drained.value.toString('utf8')
          }
          break
        }
        const r = result as { value?: Buffer; done?: boolean }
        if (r.done) break
        if (!r.value) continue
        const chunk = r.value
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim().length > 0) {
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              // skip malformed lines — we don't crash the stream over them
              nl = buf.indexOf('\n')
              continue
            }
            const ev = mapCodexEvent(parsed, mapper)
            if (ev) {
              if (ev.kind === 'completion') completionEmitted = true
              yield ev
            }
          }
          nl = buf.indexOf('\n')
        }
      }
    } catch {
      streamReadFailed = true
      // fall through to the post-loop handling below — childErrors may now be
      // populated since the 'error' event has fired.
    }
    // Drain any final partial line — Codex usually flushes a trailing \n but
    // be defensive.
    if (buf.trim().length > 0) {
      try {
        const parsed = JSON.parse(buf.trim())
        const ev = mapCodexEvent(parsed, mapper)
        if (ev) {
          if (ev.kind === 'completion') completionEmitted = true
          yield ev
        }
      } catch {
        // skip
      }
    }
    // Wait for child exit so we can report non-zero exits as errors. Resolve
    // also on the 'error' event so an ENOENT-style spawn failure does not
    // hang here forever (the OS may emit 'error' without ever emitting 'exit').
    const code = await new Promise<number>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode)
      else {
        const onExit = (c: number | null): void => {
          child.removeListener('error', onErr)
          resolve(c ?? -1)
        }
        const onErr = (): void => {
          child.removeListener('exit', onExit)
          resolve(-1)
        }
        child.once('exit', onExit)
        child.once('error', onErr)
      }
    })
    if (childErrors.length > 0 && !completionEmitted) {
      yield {
        kind: 'error',
        message: `codex child error: ${childErrors[0]!.message}`,
        retryable: false,
      }
      return
    }
    if (streamReadFailed && !completionEmitted) {
      // Stream closed prematurely with no child-error event — surface a
      // generic substrate error so callers don't see a "successful" turn.
      yield {
        kind: 'error',
        message: `codex stdout closed prematurely (exit ${code})`,
        retryable: false,
      }
      return
    }
    if (code !== 0 && !completionEmitted) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      yield {
        kind: 'error',
        message: `codex exec exited ${code}${stderr ? `: ${stderr}` : ''}`,
        retryable: false,
      }
      return
    }
    if (!completionEmitted) {
      // Codex closed without an explicit `turn.completed`. Synthesise one so
      // the substrate contract (terminal completion event) holds.
      yield {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: mapper.thread_id ?? '__codex_unknown__',
      }
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
    child.removeListener('error', onChildError)
    try {
      child.kill('SIGTERM')
    } catch {
      // best-effort — child may already be dead
    }
  }
}
