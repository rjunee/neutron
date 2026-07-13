/**
 * model-update-watchdog.ts — auto-detect a newer Claude model + gracefully move
 * sessions onto it (Vajra port row #16, docs/research/vajra-terminal-detection-
 * keystroke-port-2026-06-25.md).
 *
 * THE INCIDENT (Vajra 2026-04-16): Opus 4.7 shipped overnight and the gateway
 * sat on 4.6 for HOURS because nothing noticed the rollover — the box drifts on
 * a stale model until a human changes it by hand. This watchdog closes that gap:
 * every ~6h it asks the CLI what model id it actually is, and when a genuinely
 * NEW top-tier id appears it adopts it + gracefully respawns each warm session
 * onto the new model the moment that session is idle.
 *
 * ── THE ONE LESSON THAT MUST NOT BE LOST ──────────────────────────────────
 * The probe passes NO `--fallback-model`. With a fallback configured, during an
 * Opus OUTAGE the CLI returns the HAIKU id instead of erroring — and a naive
 * "new id → respawn" would then read Haiku as the new default and SILENTLY
 * DOWNGRADE every session to Haiku. So: probe with no fallback flag (the CLI
 * errors during an outage, which we treat as "probe failed, retry later"), and
 * as defense-in-depth REJECT any probed id that is a known fallback/downgrade
 * model ({@link isFallbackModel}) before ever treating it as a candidate.
 *
 * ── INVARIANTS (verbatim from the port brief) ─────────────────────────────
 *   • Probe NEVER passes `--fallback-model` ({@link buildProbeArgs} — pinned by
 *     test). A known-fallback id is treated as an outage, not a new model.
 *   • New-id detection is EDGE-triggered: fires once per genuinely-new id, not
 *     repeatedly while it stays new ({@link decideModelUpdate} → `notify` then
 *     `suppress`). A renotify cadence re-nags only after a long interval.
 *   • Upgrade ONLY when the session is genuinely idle: not mid-turn / typing, no
 *     tool-use prompt pending, assistant quiet ≥30s, JSONL cold ≥5s
 *     ({@link isSessionIdleForUpgrade}). Never hard-bounce an active turn.
 *   • Bounded: ONE upgrade attempt per detected new id; a session that never
 *     idles within {@link DEFAULT_PER_SESSION_UPGRADE_TIMEOUT_MS} is left on the
 *     old model (logged), not thrashed ({@link runGracefulUpgrade}).
 *
 * Pure cores (parse / decide / idle predicate / notice text) are split from the
 * side-effecting probe + cadence so the `--fallback-model` invariant, the
 * edge-latch, and the idle gate are all unit-testable without a `claude`
 * process or a live PTY. The substrate wires the real probe + pool + registry.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

// ── Cadence + threshold constants ──────────────────────────────────────────

/** How often to actually run the probe: every 6h (the {@link shouldRunModelUpdateCheck} gate). */
export const MODEL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Watchdog tick cadence. The tick is cheap (a gate check); the probe only fires
 *  once the 6h gate opens. 15 min keeps re-probe-after-failure responsive. */
export const MODEL_WATCHDOG_TICK_MS = 15 * 60 * 1000
/** Kill the probe child after this long — `claude -p` is normally seconds, but a
 *  hung CLI must not pin the watchdog forever. */
export const MODEL_PROBE_TIMEOUT_MS = 90 * 1000
/** Re-nag interval: if the same new model is STILL unadopted after this long,
 *  notify once more (covers a missed/ignored first notice). 24h. */
export const MODEL_RENOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Assistant must be quiet at least this long for a session to count as idle. */
export const IDLE_QUIESCE_MS = 30_000
/** Session JSONL must be untouched at least this long (cold) for idle. */
export const JSONL_FRESH_MS = 5_000
/** A session that never goes idle within this window is left on the old model. */
export const DEFAULT_PER_SESSION_UPGRADE_TIMEOUT_MS = 30 * 60 * 1000
/** Poll cadence for the graceful-upgrade round-robin. */
export const DEFAULT_UPGRADE_POLL_MS = 5_000

/** The exact prompt the probe sends. Asks the CLI to echo its own model id. */
export const PROBE_PROMPT = 'Reply ONLY with: MODEL_ID=<your exact model id>'

/** Parse the `MODEL_ID=<id>` line out of probe stdout. */
const MODEL_ID_RE = /MODEL_ID=([a-zA-Z0-9._-]+)/

// ── Pure cores ─────────────────────────────────────────────────────────────

/**
 * Build the probe argv. PINNED BY TEST: there is NO `--fallback-model` here.
 * Re-adding it reintroduces the 2026-04-16 Opus-outage→Haiku silent-downgrade
 * trap (see file header). `-p` makes it a one-shot print; `--model opus` asks
 * for the current top-tier alias so the returned id is whatever Opus resolves to
 * TODAY (e.g. `claude-opus-4-7` → `claude-opus-4-8` once 4.8 ships).
 */
export function buildProbeArgs(): string[] {
  return ['-p', '--model', 'opus', PROBE_PROMPT]
}

/** Extract the model id from probe stdout, or `undefined` if absent/garbled. */
export function extractModelId(stdout: string): string | undefined {
  const m = stdout.match(MODEL_ID_RE)
  return m ? m[1] : undefined
}

/**
 * Strip a trailing `-YYYYMMDD` snapshot suffix so `claude-opus-4-7-20260101` and
 * `claude-opus-4-7` compare equal (mirrors `model-pricing.ts`'s snapshot-alias
 * convention). Without this, an operator who pins a date-suffixed `BEST_MODEL`
 * would get a spurious "new model" notice on the very first probe.
 */
export function normalizeModelId(id: string): string {
  return id.replace(/-\d{8}$/, '')
}

/** Whether `id` is a known fallback/downgrade model (compared snapshot-stripped). */
export function isFallbackModel(id: string, known: ReadonlySet<string>): boolean {
  if (known.has(id)) return true
  const norm = normalizeModelId(id)
  for (const k of known) {
    if (normalizeModelId(k) === norm) return true
  }
  return false
}

/** Persisted across ticks (small JSON file). All timestamps ISO-8601 strings. */
export interface ModelUpdateState {
  /** The model id currently adopted/known. Baseline for "is this new?". */
  last_known_model?: string
  /** The model id the last notice was for — decouples renotify cadence from the
   *  probed id so a SECOND rollover inside the renotify window still fires. */
  last_notified_model?: string
  /** ISO ts of the last notice. */
  last_notified_at?: string
  /** ISO ts of the last completed probe (the 6h gate input). */
  last_checked_at?: string
}

/** The result of a single model probe. */
export type ProbeResult = { ok: true; model: string } | { ok: false; error: string }

/**
 * 6h cache gate: should the probe actually run this tick? True when never run, or
 * the recorded `last_checked_at` is ≥ `intervalMs` ago. A malformed timestamp is
 * treated as "run" (fail-open — a corrupt stamp must not freeze the watchdog).
 */
export function shouldRunModelUpdateCheck(
  now: number,
  state: ModelUpdateState,
  intervalMs: number = MODEL_CHECK_INTERVAL_MS,
): boolean {
  if (!state.last_checked_at) return true
  const last = Date.parse(state.last_checked_at)
  if (!Number.isFinite(last)) return true
  return now - last >= intervalMs
}

/** What the tick should do with a probe result. */
export type ModelUpdateDecision =
  /** The probe itself failed (CLI error / timeout / no MODEL_ID). Do NOT advance
   *  `last_checked_at` so the next tick retries. */
  | { action: 'probe-failed'; error: string }
  /** Probed id is a known fallback (an Opus outage leaking the downgrade id).
   *  Treat as outage: do NOT advance `last_checked_at` — retry, the outage clears. */
  | { action: 'skip-outage'; probed: string }
  /** Probed id matches the configured/known model — nothing to do. `seed` is set
   *  on the first-ever probe so `last_known_model` gets recorded. */
  | { action: 'no-change'; current: string; seed?: string }
  /** A genuinely new top-tier model — fire the notice + upgrade (edge `kind`). */
  | { action: 'notify'; kind: 'initial' | 'renotify'; newModel: string; oldModel: string }
  /** New model already notified inside the renotify window — stay quiet. */
  | { action: 'suppress'; newModel: string }

/**
 * Decide what to do with a probe result. PURE + TOTAL — the whole `--fallback`
 * guard + edge-latch lives here so it is testable without a process.
 *
 * Baseline for "is this new?" is `state.last_known_model ?? configuredModel`:
 * on the first-ever probe (no state) we compare against the box's CONFIGURED
 * model, so a box sitting on 4.6 while 4.7 already shipped detects it on the
 * first probe (the brief's incident) — Vajra's seed-silently-on-first-probe
 * would have missed exactly that case.
 */
export function decideModelUpdate(args: {
  probe: ProbeResult
  configuredModel: string
  state: ModelUpdateState
  knownFallbacks: ReadonlySet<string>
  now: number
  renotifyIntervalMs?: number
}): ModelUpdateDecision {
  const { probe, configuredModel, state, knownFallbacks, now } = args
  const renotifyMs = args.renotifyIntervalMs ?? MODEL_RENOTIFY_INTERVAL_MS

  if (!probe.ok) return { action: 'probe-failed', error: probe.error }
  // --fallback-model trap defense-in-depth: an Opus outage that leaks a Haiku id
  // is an outage, never a new model.
  if (isFallbackModel(probe.model, knownFallbacks)) {
    return { action: 'skip-outage', probed: probe.model }
  }

  const baseline = state.last_known_model ?? configuredModel
  const probedNorm = normalizeModelId(probe.model)
  if (probedNorm === normalizeModelId(baseline)) {
    // Seed `last_known_model` the first time so subsequent ticks have a baseline
    // independent of `configuredModel` (which a later upgrade also mutates).
    return state.last_known_model
      ? { action: 'no-change', current: probe.model }
      : { action: 'no-change', current: probe.model, seed: configuredModel }
  }

  // A genuinely new model. Edge-latch on `last_notified_model` / `last_notified_at`.
  if (state.last_notified_model && normalizeModelId(state.last_notified_model) !== probedNorm) {
    // An even newer model rolled than the one the outstanding notice is for —
    // notify immediately so the user never acks a stale version.
    return { action: 'notify', kind: 'initial', newModel: probe.model, oldModel: baseline }
  }
  if (!state.last_notified_at) {
    return { action: 'notify', kind: 'initial', newModel: probe.model, oldModel: baseline }
  }
  const notifiedMs = Date.parse(state.last_notified_at)
  if (!Number.isFinite(notifiedMs)) {
    return { action: 'notify', kind: 'initial', newModel: probe.model, oldModel: baseline }
  }
  if (now - notifiedMs >= renotifyMs) {
    return { action: 'notify', kind: 'renotify', newModel: probe.model, oldModel: baseline }
  }
  return { action: 'suppress', newModel: probe.model }
}

/** The four idle signals a session exposes (all snapshot-read by the wired layer). */
export interface SessionIdleSignals {
  /** A turn is actively streaming (mid-turn) — maps Vajra's `isTyping`. */
  isTyping: boolean
  /** An interactive tool-use / menu prompt is up (or recovery in flight) —
   *  maps Vajra's `hasToolUsePrompt`. */
  hasToolPromptPending: boolean
  /** Epoch ms of the last PTY byte (assistant-write proxy), or null if unknown. */
  lastDataAt: number | null
  /** Epoch ms of the session JSONL mtime, or null if unknown/absent. */
  jsonlMtimeMs: number | null
}

/**
 * The idle gate for a graceful upgrade — ALL four conditions must hold (mirrors
 * Vajra `isTopicIdleForUpgrade`):
 *   1. not mid-turn / typing
 *   2. no tool-use prompt pending (and not mid wedge-recovery)
 *   3. assistant quiet ≥ {@link IDLE_QUIESCE_MS} (or unknown)
 *   4. JSONL cold ≥ {@link JSONL_FRESH_MS} (or unknown)
 * A `null` signal (unknown) is treated as "satisfied" — we don't block an
 * upgrade forever on a missing transcript; the mid-turn / tool-prompt gates are
 * the load-bearing "don't hard-bounce an active turn" guards.
 */
export function isSessionIdleForUpgrade(
  s: SessionIdleSignals,
  now: number,
  opts?: { idleQuiesceMs?: number; jsonlFreshMs?: number },
): boolean {
  if (s.isTyping) return false
  if (s.hasToolPromptPending) return false
  const quiesce = opts?.idleQuiesceMs ?? IDLE_QUIESCE_MS
  const fresh = opts?.jsonlFreshMs ?? JSONL_FRESH_MS
  if (s.lastDataAt !== null && now - s.lastDataAt < quiesce) return false
  if (s.jsonlMtimeMs !== null && now - s.jsonlMtimeMs < fresh) return false
  return true
}

/** The operator/dev-channel notice body for a detected model update. */
export function buildModelUpdateNoticeText(newModel: string, oldModel: string | undefined): string {
  const fromLine = oldModel ? `(was: ${oldModel})` : '(no prior model on record)'
  return (
    `\u{1F195} New Claude model detected: ${newModel}\n` +
    `${fromLine}\n\n` +
    `\u{1F7E2} Graceful upgrade in progress — each warm session is respawned ` +
    `onto ${newModel} the moment it goes idle (not mid-turn). Conversation ` +
    `context is preserved via --resume; active turns finish on the old model ` +
    `first, so there is zero context loss.\n` +
    `\u{1F634} A session still busy after 30 min is left on the old model and ` +
    `picks up ${newModel} on its next natural respawn.`
  )
}

// ── State persistence ──────────────────────────────────────────────────────

/** Load the persisted state; `{}` when absent/corrupt (never throws). */
export function loadModelUpdateState(path: string): ModelUpdateState {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ModelUpdateState) : {}
  } catch {
    return {}
  }
}

/** Persist the state (best-effort — a write failure degrades to re-probe, never throws). */
export function saveModelUpdateState(path: string, state: ModelUpdateState): void {
  try {
    writeFileSync(path, JSON.stringify(state, null, 2))
  } catch {
    /* best-effort */
  }
}

// ── The real probe (side-effecting; async so it never blocks the event loop) ──

export interface RealProbeOptions {
  claudeBin?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** DI: a `child_process.spawn`-shaped function (tests inject a fake). */
  spawn?: typeof spawn
}

/**
 * Run the real model probe. ASYNC (uses `child_process.spawn`, not `spawnSync`)
 * so a multi-second `claude -p` round-trip never freezes the gateway event loop
 * — the heartbeat watchdog would otherwise flag the block. Resolves to a
 * {@link ProbeResult}; never rejects. Kills the child on timeout.
 */
export function realProbeModel(opts: RealProbeOptions = {}): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const bin = opts.claudeBin ?? process.env['CLAUDE_BIN'] ?? 'claude'
    const timeoutMs = opts.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS
    const spawnFn = opts.spawn ?? spawn
    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(bin, buildProbeArgs(), { env: opts.env ?? process.env })
    } catch (e) {
      resolve({ ok: false, error: `probe spawn failed: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (r: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: `probe timed out after ${timeoutMs}ms` }),
      timeoutMs,
    )
    // Don't let the probe child's pipes keep the event loop alive on their own.
    ;(timer as { unref?: () => void })?.unref?.()
    child.stdout?.on('data', (d: Buffer | string) => {
      out += d.toString()
    })
    child.stderr?.on('data', (d: Buffer | string) => {
      err += d.toString()
    })
    child.on('error', (e: Error) => finish({ ok: false, error: `probe error: ${e.message}` }))
    child.on('close', (code: number | null) => {
      const id = extractModelId(out)
      if (id !== undefined) {
        finish({ ok: true, model: id })
        return
      }
      const tail = (err || out).trim().slice(0, 200)
      finish({ ok: false, error: `no MODEL_ID in probe output (exit ${code}): ${tail}` })
    })
  })
}

// ── Graceful upgrade (round-robin, idle-gated, bounded) ────────────────────

export interface GracefulUpgradeDeps {
  /** Keys of the warm sessions to consider upgrading. */
  listSessionKeys: () => string[]
  /** Snapshot a session's idle signals, or `null` if the session is gone. May be
   *  async (the wired layer resolves a pooled `Promise<ReplSession>`). */
  idleSignals: (sessionKey: string) => SessionIdleSignals | null | Promise<SessionIdleSignals | null>
  /** Move ONE session onto the new model: rewrite its registry `model` + respawn
   *  via `--resume`. Returns true iff a respawn actually fired. */
  upgradeSession: (sessionKey: string) => boolean
  log?: (msg: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  perSessionTimeoutMs?: number
  pollMs?: number
  /** Idle-gate overrides (tests). */
  idleQuiesceMs?: number
  jsonlFreshMs?: number
}

export interface GracefulUpgradeResult {
  /** Sessions that respawned onto the new model. */
  upgraded: string[]
  /** Sessions that never went idle within the per-session timeout. */
  timedOut: string[]
  /** Sessions that vanished before they could be upgraded. */
  skipped: string[]
}

/**
 * Round-robin idle-gated upgrade (mirrors Vajra `runGracefulUpgrade`): each round
 * checks EVERY still-pending session once — upgrading any that are idle and
 * retiring any past its per-session deadline — then sleeps `pollMs` and repeats.
 * No head-of-line blocking (a busy session never holds up an idle one). Bounded:
 * one attempt per detected new id; a session that never idles is left on the old
 * model (never force-killed mid-turn).
 */
export async function runGracefulUpgrade(deps: GracefulUpgradeDeps): Promise<GracefulUpgradeResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? (() => {})
  const perSessionTimeoutMs = deps.perSessionTimeoutMs ?? DEFAULT_PER_SESSION_UPGRADE_TIMEOUT_MS
  const pollMs = deps.pollMs ?? DEFAULT_UPGRADE_POLL_MS
  const idleOpts = {
    ...(deps.idleQuiesceMs !== undefined ? { idleQuiesceMs: deps.idleQuiesceMs } : {}),
    ...(deps.jsonlFreshMs !== undefined ? { jsonlFreshMs: deps.jsonlFreshMs } : {}),
  }

  const pending = new Set(deps.listSessionKeys())
  const deadline = new Map<string, number>()
  const start = now()
  for (const k of pending) deadline.set(k, start + perSessionTimeoutMs)

  const result: GracefulUpgradeResult = { upgraded: [], timedOut: [], skipped: [] }

  while (pending.size > 0) {
    for (const key of [...pending]) {
      const signals = await deps.idleSignals(key)
      if (signals === null) {
        pending.delete(key)
        result.skipped.push(key)
        log(`model-upgrade: ${key} gone before upgrade — skipped`)
        continue
      }
      if (isSessionIdleForUpgrade(signals, now(), idleOpts)) {
        const fired = deps.upgradeSession(key)
        if (fired) {
          pending.delete(key)
          result.upgraded.push(key)
          log(`model-upgrade: ${key} idle → respawned onto new model`)
          continue
        }
        // Respawn refused (e.g. in-flight gate / cooldown) — leave it pending and
        // retry next round, still bounded by the per-session deadline below.
      }
      if (now() >= (deadline.get(key) ?? 0)) {
        pending.delete(key)
        result.timedOut.push(key)
        log(`model-upgrade: ${key} never idled within ${perSessionTimeoutMs}ms — left on old model`)
      }
    }
    if (pending.size > 0) await sleep(pollMs)
  }
  return result
}

// ── The cadence watchdog (generic, fully DI-driven) ────────────────────────

export interface ModelUpdateWatchdogDeps {
  /** Run one probe (async). Production: `() => realProbeModel({...})`. */
  probeModel: () => Promise<ProbeResult>
  /** Load / save the persisted state. */
  loadState: () => ModelUpdateState
  saveState: (state: ModelUpdateState) => void
  /** The currently-configured best model (`getBestModel()` in prod). */
  getConfiguredModel: () => string
  /** Adopt a new model as the runtime default (`setBestModelOverride` in prod). */
  adoptModel: (newModel: string) => void
  /** The known-fallback set (`getKnownFallbackModels()` in prod). */
  knownFallbacks: () => ReadonlySet<string>
  /** Surface the upgrade notice (dev-channel / operator alert). */
  postNotice: (notice: { newModel: string; oldModel: string; text: string }) => void
  /** Run the idle-gated graceful upgrade of every warm session onto `newModel`. */
  runUpgrade: (newModel: string) => Promise<void> | void
  /** Tick cadence (ms). Default {@link MODEL_WATCHDOG_TICK_MS}. */
  intervalMs?: number
  /** Probe gate interval (ms). Default {@link MODEL_CHECK_INTERVAL_MS} (6h). */
  checkIntervalMs?: number
  renotifyIntervalMs?: number
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  now?: () => number
  log?: (msg: string) => void
  onError?: (err: unknown) => void
}

export interface ModelUpdateWatchdog {
  stop(): void
  /** Run one tick synchronously-awaitable (the cadence calls this; tests drive it). */
  tick(): Promise<void>
}

/**
 * Start the model-update watchdog. Every `intervalMs` it checks the 6h gate; once
 * the gate opens it probes the CLI's model id (NO `--fallback-model`), decides
 * via {@link decideModelUpdate}, and on a genuinely-new id: posts the notice,
 * adopts the model as the runtime default, persists state, and kicks off the
 * idle-gated graceful upgrade. A probe failure / outage does NOT advance the gate
 * so the next tick retries.
 */
export function startModelUpdateWatchdog(deps: ModelUpdateWatchdogDeps): ModelUpdateWatchdog {
  const intervalMs = deps.intervalMs ?? MODEL_WATCHDOG_TICK_MS
  const checkIntervalMs = deps.checkIntervalMs ?? MODEL_CHECK_INTERVAL_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const onError =
    deps.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[model-update] tick error: ${err instanceof Error ? err.message : String(err)}\n`,
      ))
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: unknown) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]))

  // Re-hydrate a previously-adopted model on (re)start (Codex P1). The runtime
  // override (`setBestModelOverride`) is PROCESS-LOCAL and resets to undefined on
  // every restart, but `last_known_model` is PERSISTED. Without this, after a
  // gateway restart the next probe returns the SAME already-adopted model, takes
  // the `no-change` path, and NEVER re-applies the override — so fresh sessions
  // silently revert to the stale env/default `BEST_MODEL` until an even-newer
  // model ships (the auto-upgrade quietly un-does itself across restarts).
  // Restore it here, but ONLY when the persisted model genuinely differs from the
  // configured base (so a plain seed is a no-op) and is not a fallback id.
  try {
    const persisted = deps.loadState()
    const adopted = persisted.last_known_model
    if (
      adopted !== undefined &&
      !isFallbackModel(adopted, deps.knownFallbacks()) &&
      normalizeModelId(adopted) !== normalizeModelId(deps.getConfiguredModel())
    ) {
      deps.adoptModel(adopted)
      log(`model-update: re-applied persisted model ${adopted} on start`)
    }
  } catch (e) {
    onError(e)
  }

  // One probe / upgrade at a time — a probe can take seconds and the upgrade
  // minutes; overlapping ticks would double-probe + race the adopt.
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight) return
    const t = now()
    const state = deps.loadState()
    if (!shouldRunModelUpdateCheck(t, state, checkIntervalMs)) return
    inFlight = true
    try {
      const probe = await deps.probeModel()
      const decision = decideModelUpdate({
        probe,
        configuredModel: deps.getConfiguredModel(),
        state,
        knownFallbacks: deps.knownFallbacks(),
        now: now(),
        ...(deps.renotifyIntervalMs !== undefined ? { renotifyIntervalMs: deps.renotifyIntervalMs } : {}),
      })
      const nowIso = new Date(now()).toISOString()

      switch (decision.action) {
        case 'probe-failed':
          // Do NOT advance last_checked_at — retry next tick (the CLI errored;
          // during an Opus outage with no fallback this is the EXPECTED path).
          log(`model-update: probe failed — ${decision.error}`)
          break
        case 'skip-outage':
          // A fallback id leaked (outage). Do NOT advance the gate — retry; the
          // outage will clear and a real id come back.
          log(`model-update: probe returned known fallback ${decision.probed} — treating as outage`)
          break
        case 'no-change': {
          const next: ModelUpdateState = { ...state, last_checked_at: nowIso }
          if (decision.seed) next.last_known_model = decision.seed
          deps.saveState(next)
          break
        }
        case 'suppress':
          deps.saveState({ ...state, last_checked_at: nowIso })
          break
        case 'notify': {
          log(
            `model-update: new model ${decision.newModel} (was ${decision.oldModel}) — ` +
              `${decision.kind} notice + graceful upgrade`,
          )
          deps.postNotice({
            newModel: decision.newModel,
            oldModel: decision.oldModel,
            text: buildModelUpdateNoticeText(decision.newModel, decision.oldModel),
          })
          // Adopt as the runtime default so FRESH spawns use it immediately.
          deps.adoptModel(decision.newModel)
          deps.saveState({
            ...state,
            last_known_model: decision.newModel,
            last_notified_model: decision.newModel,
            last_notified_at: nowIso,
            last_checked_at: nowIso,
          })
          // Fire-and-forget the idle-gated graceful respawn of existing warm
          // sessions. Errors are swallowed — the adopt + notice already shipped.
          fireAndForget('model-update-watchdog.resolve', Promise.resolve(deps.runUpgrade(decision.newModel)), onError)
          break
        }
      }
    } catch (err) {
      onError(err)
    } finally {
      inFlight = false
    }
  }

  const handle = setIntervalFn(() => {
    // `tick()` self-handles (its own try/catch calls onError + resets inFlight),
    // so the old `.catch(onError)` was redundant. fireAndForget is the structural
    // backstop: it fires only if tick() itself rejects (e.g. onError throws).
    fireAndForget('model-update-watchdog.tick', tick())
  }, intervalMs)
  // Don't let the cadence timer hold the event loop open on its own.
  ;(handle as { unref?: () => void })?.unref?.()

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
    },
    tick,
  }
}
