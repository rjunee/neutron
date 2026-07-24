// persistent-repl-substrate.ts → repl-session.ts
// The ReplSession warm-REPL class + child-termination / env / http-health
// helpers (D2 split).

import { createHash, randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import type { LiveProcessHandle } from '@neutronai/tools/process-registry.ts'
import type { Api5xxWatcherHandle } from './api5xx-dead-turn-watcher.ts'
import { OutputScanner } from './output-scan.ts'
import type { PtyChild } from './pty-host.ts'
import { PtyRing, type RecentOutputOpts } from './pty-ring.ts'
import type { SessionSizeWatchdog } from './session-size-watchdog.ts'
import { CHILD_KILL_GRACE_MS, ZERO_USAGE, defaultIsPidAlive } from './signatures.ts'
import type { ActiveTurn } from './types.ts'

// ---------------------------------------------------------------------------
// ReplSession — one warm REPL + its dev-channel + its turn serialization.
// ---------------------------------------------------------------------------


export class ReplSession {
  channelPort: number | undefined
  private readyResolve: (() => void) | undefined
  readonly ready: Promise<void>
  activeTurn: ActiveTurn | undefined
  /** The ACTIVE project scope this warm REPL serves (`options.project_id`).
   *  The pool key folds `project_id` in (`poolKeyFor`), so one session serves
   *  exactly ONE project scope for its whole lifetime — `'general'` (or absent)
   *  for the General surface, the project id otherwise. The topic-agnostic
   *  `/tool-call` sink reads it to thread the active project into the tool
   *  dispatch, so an agent `work_board_*` write scopes to the composing turn's
   *  project instead of falling back to the owner/General slug. */
  projectId: string | undefined
  /** ABANDON-POISON flag (2026-06-18 warm-session hang fix). Set true when a turn
   *  on this warm REPL is ABANDONED before its reply lands — the caller's budget
   *  elapsed (`handle.cancel()`, e.g. the synthesis `dispatchTurn` 90s timeout) OR
   *  the substrate's own `turnTimeoutMs` fired. The REPL keeps RUNNING that
   *  abandoned turn; its late `reply()` then arrives while the NEXT turn is in
   *  flight, where the dev-channel's stale-reply debt strips the reply's `turn_id`
   *  (`got_turn=<none>`) and the substrate rejects it — so the next turn (and
   *  every turn after it) never delivers. ONE runaway turn permanently poisons the
   *  warm session = the production hang (synthesis import: every read pass timed
   *  out, dollars_spent=0, the empty fallback "completed"). `getOrSpawnSession`
   *  treats a poisoned session like a failed freshness guard: it evicts + respawns
   *  a CLEAN REPL (fresh dev-channel, no debt, no runaway) before the next turn, so
   *  a single slow/wedged turn can no longer cascade. The accumulating synthesis
   *  model survives a respawn because each read prompt carries the running model
   *  explicitly (`buildReadPrompt` runningProjects/runningPeople), not only the
   *  REPL's in-context memory. */
  poisoned = false
  /** Timestamp of the last byte the REPL's PTY emitted. Used to gate the NEXT
   *  turn's inject on the REPL going idle — injecting a channel notification
   *  while claude is still finishing the prior turn drops the notification
   *  (the back-to-back-turn race that timed out the 3-turn proof). */
  lastDataAt = Date.now()
  /** F1: the public, line-addressable PTY ring. Every chunk the child emits is
   *  appended here; `getRecentOutput` reads it (line-addressable, bottom-N,
   *  optionally normalized). Replaces the old debug-gated 16 KB closure. */
  readonly ring = new PtyRing()
  /** F3: the output-scan detector framework. The disclaimer auto-dismiss is
   *  registered here (generalized from the old inline `onData` check); the
   *  P0/P1 recovery detectors register signature+action in follow-on PRs. */
  readonly scanner = new OutputScanner()
  /** Master-table row #11: the per-turn API-5xx dead-turn JSONL watcher for THIS
   *  child's transcript. Started right after spawn (sessionId + cwd are known →
   *  the JSONL path is resolvable) and stopped on child death. Distinct from the
   *  PTY-ring `scanner` above — this watches disk, not the terminal. */
  deadTurnWatcher: Api5xxWatcherHandle | undefined
  /** True while the wedged-interactive-prompt escape/ctrl-c recovery ladder is
   *  in flight, so a second scan tick can't launch a concurrent ladder on the
   *  same still-present menu (the scanner latch already guards the rising edge;
   *  this guards the async window the ladder runs in). */
  wedgeRecovering = false
  /** True while the resume-session-picker escape-then-recover ladder (P2, row #7)
   *  is in flight, so a second scan tick can't launch a concurrent recovery on
   *  the same still-present picker (the scanner latch guards the rising edge; this
   *  guards the async window the ladder runs in). */
  resumePickerRecovering = false
  /** Set by the resume-session-picker recovery (row #7) to the session id it
   *  recovered from disk. When this session is later evicted (it is also marked
   *  `poisoned`), `getOrSpawnSession` carries this as a `forceResume` directive so
   *  the clean respawn `--resume`s the RECOVERED transcript instead of re-reading
   *  the stale-id registry (which would drop straight back into the picker). This
   *  is what makes the recovery actually move the live REPL onto the recovered
   *  context, not merely patch a registry the warm child never re-reads (Codex P1);
   *  it also sidesteps racing `spawnSession`'s own registry write. */
  pendingResumeSessionId: string | undefined
  /** Set by the resume-session-picker recovery (row #7) when the disk scan found
   *  NOTHING to recover. `spawnSession` optimistically wrote the registry as
   *  `has_session: true` for the stale `--resume` id that dropped into the picker,
   *  so a later crash/watchdog respawn would re-`--resume` it and reopen the same
   *  picker. This flag (paired with `poisoned`) makes the next turn evict + respawn
   *  with resume FORCED OFF — a clean fresh spawn whose `spawnSession` rewrites the
   *  registry `has_session: false`, breaking the stale-resume loop (Codex P2). */
  forceFreshRespawn = false
  /** Timestamp (ms) the auth-failure output-scan signature last fired on this
   *  session's PTY ring — the `claude` child reported an invalid/expired credential
   *  (`OAuth access token is invalid` / `Please run /login` / a 401·403 `API Error`;
   *  see `auth-failure-signature.ts`). Set by `dispatchAuthFailureNotice` on the
   *  scanner's rising edge; read by the pool driver's per-turn timeout watchdog,
   *  which — when this was stamped DURING the current turn — fails the turn FAST with
   *  a distinct `auth_invalid` class instead of waiting out the full inactivity
   *  window and misclassifying the freeze as a generic timeout. Undefined until an
   *  auth failure is observed; a fresh (respawned) session starts clean. */
  authFailureAt: number | undefined
  /** The verbatim (trimmed, ANSI-stripped) auth-failure line that last matched —
   *  surfaced in the operator notice for cross-checking WHICH credential error
   *  fired. Never embedded in the user-facing bubble (that stays generic). */
  authFailureMatched: string | undefined
  /** Vajra port row #13: the warm-session size watchdog. Started right after the
   *  post-spawn assertion passes; measures the POST-COMPACT JSONL size on a
   *  cadence and surfaces a Reset/Compact affordance before the transcript grows
   *  large enough to block `--resume`. Stopped on child exit / teardown. Exposes
   *  `requestCompact()` for the surfaced Compact affordance (see
   *  `requestSessionCompact`). */
  sizeWatchdog: SessionSizeWatchdog | undefined
  /** The built-in tool surface this REPL was SPAWNED with, as a stable
   *  comma-joined key (`--tools` value). The reuse guard refuses to serve a turn
   *  whose requested surface differs, so a less-privileged turn (e.g. an import
   *  `tools:[]`) can never reuse a more-privileged warm REPL (Codex-r1-P1). */
  toolSurface = ''
  /** P0-1 — whether this REPL was SPAWNED with the native-MCP tool bridge
   *  attached. Like {@link toolSurface}, it is a spawn-time property the reuse
   *  guard checks so a bridge-mismatched turn never reuses this warm child
   *  (defense-in-depth: the bridge restriction stays local, not keying-dependent). */
  toolBridgeActive = false
  /** Fingerprint of the auth secret this REPL was SPAWNED with (`CLAUDE_CODE_
   *  OAUTH_TOKEN` / `ANTHROPIC_API_KEY`), hashed so no second plaintext copy of
   *  the secret lives on the long-held session. The credential-freshness reuse
   *  guard compares the CURRENT dispatch's fingerprint against this: the pool key
   *  folds the STABLE `PooledCredential.id`, NOT the rotating token VALUE, so a
   *  per-dispatch OAuth refresh under the same credential id would otherwise keep
   *  serving turns on the warm child's now-expired token (Codex r2 P1). Empty
   *  when no env auth secret is present — the interactive-Max-login model
   *  authenticates via `claudeConfigDir`'s credentials.json and self-refreshes,
   *  so there is nothing to fingerprint and the guard is correctly inert. */
  authFingerprint = ''
  /** Per-session temp config files (`neutron-repl-*-mcp.json` + `*-settings.json`)
   *  this REPL was spawned with. Stashed so teardown can unlink them — an ephemeral
   *  one-shot spawns a fresh pair per call, so without cleanup they accumulate in
   *  `tmpdir()` forever, directly countering the bounding-growth goal (Argus r5
   *  IMPORTANT). Unlinked on dispose + on child exit (covers pool + crash). */
  configPaths: readonly string[] = []
  /** F4 — the watchdog live-process handle for THIS incarnation's child, set by
   *  `spawn.ts` right after it registers the PID. The dispatch site uses it to
   *  declare a turn outstanding (`markTurnStarted`) and to clear it in a
   *  `finally` (`markTurnSettled`) — the ONLY input to stuck-agent detection.
   *  Undefined before the child is registered, and a no-op handle when no
   *  ambient registry exists (unit tests / LLM-less box). */
  liveHandle: LiveProcessHandle | undefined
  /** Notices that must reach the user but were produced while NO turn was active.
   *  The resume-picker recovery (row #7) fires during SPAWN — before `start()`
   *  assigns `activeTurn` — so its "session recovered/lost" notice would be a
   *  silent no-op if pushed straight to `activeTurn?.channel` (Codex P2). Buffer
   *  here and flush onto the first live turn's channel via `flushPendingNotices`. */
  private pendingNotices: string[] = []
  /** The PTY child — attached right after spawn (we register the session in
   *  the sink BEFORE spawning so a fast /channel-ready can't race). */
  private childRef: PtyChild | undefined
  /** Per-session turn mutex: only one turn injected at a time. */
  private turnTail: Promise<void> = Promise.resolve()
  /** Monotonic per-incarnation turn-sequence source. Combined with `incarnation`
   *  into `activeTurn.turnId` so a reply can be correlated to the exact turn that
   *  produced it (see `ActiveTurn.turnId`). RESETS per `ReplSession` — which is
   *  why a bare seq is not enough across a resume (see `incarnation`). */
  private turnSeq = 0
  /** Per-spawn (per-incarnation) nonce. A resume re-attaches the SAME
   *  `sessionId` under a NEW `ReplSession`, where `turnSeq` restarts at 0; this
   *  nonce makes a turn-id from a prior (killed) incarnation un-matchable against
   *  this one, closing the cross-resume turnId collision (Argus r6). One
   *  `ReplSession` == one incarnation == one nonce. */
  private readonly incarnation: string = randomBytes(4).toString('hex')

  /** Mint this incarnation's next turn-id as `<incarnation>:<seq>` — globally
   *  unique across incarnations of the same `sessionId` (see `ActiveTurn.turnId`). */
  nextTurnId(): string {
    this.turnSeq += 1
    return `${this.incarnation}:${this.turnSeq}`
  }

  /** Number of turns this incarnation has begun (the monotonic `turnSeq`).
   *  0 ⇒ no turn injected yet on this freshly-spawned/resumed REPL — its
   *  conversation is empty, so the per-turn context-reset (`/clear`) is a
   *  no-op and is skipped. >0 ⇒ this warm REPL already served a turn, so a
   *  reset is needed before the next one to isolate per-turn context. */
  turnsServedThisIncarnation(): number {
    return this.turnSeq
  }

  constructor(
    readonly sessionKey: string,
    readonly sessionId: string,
    readonly channelName: string,
  ) {
    this.ready = new Promise<void>((res) => {
      this.readyResolve = res
    })
  }

  attachChild(child: PtyChild): void {
    this.childRef = child
  }

  /** F1 public ring-read accessor. Recent PTY output for a content detector:
   *  `{ bottomN }` for a line-addressed bottom-N slice, `{ normalize }` to
   *  collapse Ink ANSI for contiguous-signature matching. Always available (no
   *  longer `NEUTRON_REPL_DEBUG`-gated). */
  getRecentOutput(opts: RecentOutputOpts = {}): string {
    return this.ring.getRecentOutput(opts)
  }

  get child(): PtyChild {
    if (this.childRef === undefined) throw new Error('repl-session: child not attached')
    return this.childRef
  }

  hasChildExited(): boolean {
    return this.childRef === undefined || this.childRef.hasExited()
  }

  onChannelReady(port: number): void {
    if (port > 0) this.channelPort = port
    if (this.readyResolve) {
      this.readyResolve()
      this.readyResolve = undefined
    }
  }

  /** True once the dev-channel POSTed `/channel-bound` — claude completed the MCP
   *  `initialize`/`initialized` handshake and wired the `claude/channel`
   *  capability. This is the post-spawn assertion's TRUE readiness gate (Stage 4),
   *  replacing the false-positive "no MCP server configured with that name" TUI
   *  scan (claude 2.1.186 prints that warning even for a fully-wired channel). */
  channelBound = false

  onChannelBound(): void {
    this.channelBound = true
  }

  onReply(text: string, turnId?: string): void {
    const t = this.activeTurn
    // Accept a reply ONLY if its turn-id correlates to the CURRENT turn (Argus
    // r5 / r6 / Codex GPT-5 BLOCKER — see `ActiveTurn.turnId`). The
    // `<incarnation>:<seq>` id rejects a straggler from a prior turn (different
    // seq) AND from a prior incarnation of the same resumed session (different
    // nonce), in both the pre-inject-park and inject-in-flight windows. A real
    // reply for this turn always carries this turn's id, so this never drops a
    // legitimate completion — and a reply tagged with this turn's id cannot
    // exist before this turn injects, so no separate `injected` flag is needed.
    if (t === undefined || t.settled || t.turnId !== turnId) {
      // Telemetry: a drop is never silent (Argus r6). Only an actual reject —
      // an idle session with no active turn produces no reply, so this fires on
      // a genuine straggler / desync, not steady state.
      if (t !== undefined && !t.settled) {
        process.stderr.write(
          `[repl-sink] dropped uncorrelated reply: session=${this.sessionId.slice(0, 8)} expected_turn=${t.turnId} got_turn=${turnId ?? '<none>'}\n`,
        )
      }
      return
    }
    t.settled = true
    // The 1:1 bridge: one reply → one token + one completion.
    t.channel.push({ kind: 'token', text })
    t.channel.push({
      kind: 'completion',
      usage: ZERO_USAGE,
      session: { id: t.sessionId, last_active_at: Date.now() },
      substrate_instance_id: t.substrateInstanceId,
    })
    t.channel.close()
    t.settle()
  }

  onTyping(): void {
    const t = this.activeTurn
    if (t === undefined || t.settled) return
    t.channel.push({ kind: 'status', message: 'working' })
  }

  /** Surface a status notice to the user. Pushed straight onto the active turn's
   *  channel when a turn is live, otherwise BUFFERED until the next turn flushes
   *  it (`flushPendingNotices`). The resume-picker recovery surfaces through here
   *  because it fires at SPAWN time, before any turn exists (Codex P2). */
  pushNotice(text: string): void {
    const t = this.activeTurn
    if (t !== undefined && !t.settled) {
      t.channel.push({ kind: 'status', message: text })
    } else {
      this.pendingNotices.push(text)
    }
  }

  /** Drain any spawn-time buffered notices onto the current live turn's channel.
   *  Called by `start()` once a turn is injected + its channel is confirmed
   *  working, so a "session recovered/lost" notice produced before the turn
   *  existed still reaches the user on the very next turn. No-op when empty. */
  flushPendingNotices(): void {
    const t = this.activeTurn
    if (t === undefined || t.settled || this.pendingNotices.length === 0) return
    for (const text of this.pendingNotices) t.channel.push({ kind: 'status', message: text })
    this.pendingNotices = []
  }

  /** Fail the in-flight turn (process death). Retryable so the caller respawns. */
  onDeath(): void {
    const t = this.activeTurn
    if (t === undefined || t.settled) return
    t.settled = true
    t.diedMidTurn = true
    t.channel.push({ kind: 'error', message: 'persistent-repl: REPL process exited', retryable: true })
    t.channel.close()
    t.settle()
  }

  /** Acquire the per-session turn slot; returns a release fn. Serializes turns
   *  so the warm REPL never has two channel turns in flight at once. */
  async acquireTurn(): Promise<() => void> {
    let release: () => void = () => {}
    const prev = this.turnTail
    this.turnTail = new Promise<void>((res) => {
      release = res
    })
    await prev
    return release
  }
}

// D1: `pool` / `childByKey` / `ephemeralSessions` / `pendingChildKills` live in
// `pool-state.ts`, imported above.

/** Graceful child termination: SIGTERM, await exit up to `CHILD_KILL_GRACE_MS`,
 *  then SIGKILL if it overstays. Resolves once the child is gone (or the force
 *  deadline elapses). Safe on an already-dead child (resolves immediately). */
export async function terminateChild(child: PtyChild): Promise<void> {
  if (child.hasExited()) return
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  const exited = child.exited.then(() => true)
  const graced = Bun.sleep(CHILD_KILL_GRACE_MS).then(() => false)
  const cleanlyExited = await Promise.race([exited, graced]).catch(() => false)
  if (cleanlyExited || child.hasExited()) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await Promise.race([child.exited, Bun.sleep(CHILD_KILL_GRACE_MS)]).catch(() => undefined)
}

/** Graceful termination by raw PID — the cross-restart orphan path where there is
 *  no `PtyChild` handle (the surviving process belongs to a prior gateway
 *  incarnation). SIGTERM, poll for exit up to `CHILD_KILL_GRACE_MS`, then SIGKILL
 *  and poll AGAIN for exit before resolving. Safe on an already-dead pid (returns
 *  immediately). Called ONLY after `adoptOrKillOrphan` has VERIFIED the pid is our
 *  `claude` for the session (ISSUES #105) — never on an unverified / recycled pid.
 *
 *  The post-SIGKILL poll is load-bearing for the one-process-per-transcript
 *  invariant (Codex P2): `spawnResume` AWAITS this promise before launching the
 *  `--resume` replacement, so if a stubborn orphan ignores SIGTERM through the
 *  grace window we must not resolve the instant SIGKILL is *sent* — SIGKILL reaps
 *  asynchronously, and resolving early would let the replacement briefly co-own the
 *  transcript with a not-yet-dead orphan. Mirror `terminateChild`: poll until the
 *  pid is gone (or a second grace window elapses — the SAFE bound; a pid that
 *  survives SIGKILL is unkillable by us, so blocking forever buys nothing).
 *
 *  `stillOurs` is re-checked IMMEDIATELY before SIGKILL (recycled-pid safety, Codex
 *  P2 round 2): the verified orphan can exit under SIGTERM and the OS can recycle
 *  its pid onto an UNRELATED process during the multi-second grace window, after
 *  which a blind SIGKILL would hit that innocent process. Re-reading the cmdline
 *  here collapses the grace-window TOCTOU to a synchronous one (the same residual
 *  window every signal has). Default `() => true` preserves behavior for callers
 *  that don't supply an identity predicate. */
export async function terminatePidGracefully(
  pid: number,
  stillOurs: () => boolean = () => true,
): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  if (await waitForPidExit(pid, CHILD_KILL_GRACE_MS)) return
  // The orphan outlasted the SIGTERM grace window. Before force-killing, confirm
  // the pid is STILL our claude — if it exited and the OS recycled the number, the
  // SIGKILL must NOT fire on the recycled process.
  if (!stillOurs()) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return // reaped between the poll and the signal
  }
  await waitForPidExit(pid, CHILD_KILL_GRACE_MS)
}

/** Poll `defaultIsPidAlive(pid)` until the pid is gone or `budgetMs` elapses.
 *  Returns true if it observed the pid exit within the budget, false on timeout.
 *  Pure liveness poll — issues no signals. */
async function waitForPidExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!defaultIsPidAlive(pid)) return true
    await Bun.sleep(50)
  }
  return !defaultIsPidAlive(pid)
}

/** Unlink a session's temp config files (`neutron-repl-*-mcp.json` +
 *  `*-settings.json`). Best-effort + idempotent (ENOENT ignored), so it is safe to
 *  call from both the dispose path and the child-exit handler. Without this, every
 *  ephemeral one-shot leaves two permanent files in `tmpdir()` (Argus r5). */
export function unlinkSessionConfigs(session: ReplSession): void {
  for (const p of session.configPaths) {
    try {
      unlinkSync(p)
    } catch {
      /* already gone / never written */
    }
  }
}

/**
 * Env vars that let the PARENT process inject code into the child interpreter.
 * Stripped unconditionally — a CC child must never inherit them.
 *
 * WHY (adversarial security review, 2026-07-20): `mergeEnv` starts from the
 * gateway's whole `process.env` and previously deleted ONLY what a composer
 * overlay explicitly unset (the three Anthropic auth vars, ISSUES #49). None of
 * these four were ever named anywhere in this file, so a gateway environment
 * carrying `NODE_OPTIONS=--require /path/evil.js` — or `LD_PRELOAD` /
 * `DYLD_INSERT_LIBRARIES` — was arbitrary code execution inside EVERY spawned
 * Claude child. It required the gateway's own env to be poisoned first, so this
 * is defense-in-depth rather than a remotely-reachable hole, but there is no
 * legitimate reason for a child to inherit any of them.
 *
 * Deleted here rather than in a composer overlay so it holds for EVERY caller —
 * a new substrate factory cannot forget it.
 */
const CODE_INJECTION_ENV_VARS = [
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
] as const

export function mergeEnv(overlay: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env }
  // Strip interpreter-injection vars BEFORE the overlay, so an explicit overlay
  // value still wins if a caller ever legitimately needs one (none do today).
  for (const k of CODE_INJECTION_ENV_VARS) delete base[k]
  if (overlay !== undefined) {
    // ISSUES #49 — an `undefined` overlay value means "DELETE from the inherited
    // env", not "set to undefined". This is the credential-scrub contract: a
    // composer unsets the three Anthropic auth vars and sets exactly the selected
    // one, so a host-leaked `ANTHROPIC_API_KEY` can't survive into the child and
    // out-rank the pool credential (cross-credential billing leak). Now that the
    // persistent REPL is the sole substrate this delete MUST happen here (it was
    // formerly the retired per-turn path's env-merge responsibility).
    for (const [k, v] of Object.entries(overlay)) {
      if (v === undefined) delete base[k]
      else base[k] = v
    }
  }
  return base
}

/** Fingerprint the auth secret an env overlay carries (the one the composer
 *  scrubs to per ISSUES #49), so the warm-reuse credential-freshness guard can
 *  detect a per-dispatch OAuth token REFRESH under the SAME credential id. The
 *  pool key folds the STABLE `PooledCredential.id`, not the rotating token VALUE
 *  (#104), so without this a warm REPL keeps serving turns on an expired token
 *  after the access token rotates (Codex r2 P1). Hashed (never the plaintext
 *  secret) so no second copy of the token lives on the long-held session object.
 *  Returns `''` when no auth secret is present — the interactive-Max-login model
 *  authenticates via `claudeConfigDir`'s credentials.json + self-refresh, so
 *  there is no env token to fingerprint and the guard stays inert. */
export function authFingerprintFor(env: Record<string, string | undefined> | undefined): string {
  if (env === undefined) return ''
  const secret = env['CLAUDE_CODE_OAUTH_TOKEN'] ?? env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY']
  if (typeof secret !== 'string' || secret.length === 0) return ''
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** Health-probe deadline. A dev-channel wedged enough to ACCEPT the connection
 *  but never answer `/health` would otherwise hang this fetch forever — and since
 *  `runReplWatchdogTick` awaits the probe while holding its per-registry tick gate,
 *  one hung probe would stall ALL later ticks + respawn recovery, defeating the wedge
 *  detector in exactly the failure mode it exists to catch (Codex P2). The probe
 *  must finish well inside the watchdog cadence; a timeout reads as health-dead →
 *  the tick proceeds to respawn. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000

export interface HttpHealthOptions {
  /** Expected dev-channel session id. When set, a `/health` whose `session_id`
   *  doesn't match is treated as NOT healthy — defends against a recorded port
   *  that the OS recycled to a DIFFERENT REPL while this session is wedged (the
   *  dev-channel echoes `session_id` for exactly this guard). When omitted, any
   *  `{ok:true}` passes (back-compat / identity-agnostic probe). */
  expectedSessionId?: string
  /** Probe deadline. */
  timeoutMs?: number
}

export async function httpHealth(port: number, opts: HttpHealthOptions = {}): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS),
    })
    if (!resp.ok) return false
    const body = (await resp.json()) as { ok?: boolean; session_id?: string }
    if (body.ok !== true) return false
    // Port-recycle guard: a recycled port serving a DIFFERENT session reads as
    // wedged (→ respawn), never as this session being healthy.
    if (opts.expectedSessionId !== undefined && body.session_id !== opts.expectedSessionId) {
      return false
    }
    return true
  } catch {
    // Network error, non-2xx, malformed body, OR the probe deadline — all mean
    // "not provably healthy" → the wedge detector treats it as health-dead.
    return false
  }
}

