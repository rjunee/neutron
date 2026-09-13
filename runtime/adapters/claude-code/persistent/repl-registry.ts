/**
 * repl-registry.ts — the persisted REPL registry (substrate-lift S2).
 *
 * The Neutron analog of Nova's topic-map row, scoped to the persistent-REPL
 * substrate. It is the ONE piece of supervision state that must SURVIVE a
 * gateway restart: it records, per `sessionKey`, the resumable session UUID
 * (`--resume <sessionId>`), the last-known child `pid` + dev-channel port (for
 * liveness probes), and the respawn-supervision bookkeeping (in-flight stamp,
 * rolling-window respawn counts, hard cap). Without it, a crash/restart loses
 * the sessionId and the next spawn would cold-start FRESH (the S1 context-loss
 * gap, brief § 0).
 *
 * Persistence + concurrency model (brief § 1 #4, § 2 row #12):
 *   - On-disk shape is a JSON object keyed by `sessionKey` (mirrors topic-map).
 *   - Every read-modify-write goes through `withFlockSync` on the registry's
 *     lockfile so two concurrent watchdog ticks (or a tick racing a `start()`
 *     cold-resume) can't both decide to spawn for the same key. Each mutation
 *     RE-READS disk inside the lock so a row another tick appended between a
 *     stale read and our write is never clobbered (TOCTOU-safe).
 *   - Atomic write (tmp → fsync → rename) so a crash mid-write never leaves a
 *     truncated registry.
 *   - A CORRUPT on-disk file (unparseable JSON or wrong shape) never brings
 *     supervision down — `loadRegistry` maps it to `{}` — but a mutation
 *     built on that `{}` would otherwise silently overwrite the file and
 *     vaporize every other sessionKey's row with zero signal. Same story,
 *     smaller blast radius, for a single MALFORMED row (schema skew from a
 *     rolling restart) that `isMinimalRecord` drops during parse. The
 *     mutation path (`withRegistry` and the `*Record` helpers) guards BOTH:
 *     it logs loudly AND best-effort sidecars the pre-loss raw bytes to a
 *     collision-resistant `<path>.corrupt-<epoch-ms>-<pid>-<counter>` before
 *     the save makes the drop permanent, so rows are recoverable by hand. See
 *     `defaultCorruptHandler` / `defaultDropRowHandler`.
 *   - A whole-file READ error (EACCES, EMFILE, a transient I/O hiccup — as
 *     opposed to a parse/shape error) is handled MORE conservatively still:
 *     there are no bytes to sidecar and no way to know the failure wasn't
 *     momentary, so the mutation path skips the SAVE entirely rather than
 *     committing a `{}`-based rebuild — the file is left untouched for the
 *     next tick to retry. See `loadRegistryForMutation`.
 *
 * Keyed on the `sessionKey` STRING the substrate already uses
 * (`${substrate_instance_id} ${cwd}` today; `(instance, user, project)` after S3
 * re-namespaces it). This module never parses or constructs the composite — it
 * treats `sessionKey` as an opaque key, so S2 supervision follows S3's keying
 * with zero rework (brief § 8).
 */

import { createLogger } from '@neutronai/logger'
import { readFileSync, writeFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../../../atomic-write.ts'
import { registryLockPath, withFlockSync } from './registry-lock.ts'
import type { ProcessIdentity } from './process-identity.ts'

const log = createLogger('repl-registry')

/**
 * How long a gateway-shutdown kill entry is retained.
 *
 * THE RETENTION RULE IS AGE, NOT COUNT, and that correction matters. An earlier revision
 * kept the newest 16 entries and justified the number by trident's two-hour in-flight
 * ceiling — but a time ceiling bounds DURATION while a count cap is driven by RESTART
 * RATE, and nothing ties the two. Sixteen restarts on one session key inside the window
 * evicted a generation that still owned a running build, whose attribution was then
 * unrecoverable: the stranding the whole change exists to prevent, caused by the cap
 * meant to be harmless.
 *
 * So the entry that can still be referenced is the entry that is kept. Reachability is
 * bounded by trident's hard in-flight ceiling — `DEFAULT_MAX_INFLIGHT_MS`, 2 h in
 * `trident/liveness.ts` — because no run can be in flight longer than that, so no entry
 * older than it can be asked about. Doubled here for margin, since the coupling is
 * documented rather than enforced (the runtime band may not import trident) and a
 * retention window that is slightly too generous costs kilobytes while one that is too
 * short costs a build's failure reason.
 */
export const GATEWAY_SHUTDOWN_KILL_RETENTION_MS = 4 * 60 * 60_000

/**
 * AN ALARM THRESHOLD, NOT A CAP. Nothing is evicted for crossing it.
 *
 * It used to slice the row down to this many entries, which contradicted the sentence
 * directly above it: with more than this many entries all genuinely inside the retention
 * window, the "backstop" became the PRIMARY rule and discarded the oldest still-live
 * attribution — exactly the loss this whole mechanism exists to prevent, under exactly
 * the load that makes it likely.
 *
 * It does not need to evict, because THE AGE RULE ALREADY BOUNDS GROWTH: every entry
 * outside `GATEWAY_SHUTDOWN_KILL_RETENTION_MS` is released, so the most a row can hold is
 * the number of shutdowns that landed on one session key inside that window. Crossing
 * this threshold therefore means something pathological is restarting the key — roughly a
 * restart a minute, sustained for hours — which is a thing to SAY rather than a thing to
 * paper over by dropping evidence. The crash-loop guard (`restart-rate.ts`) is what exists
 * to catch the cause.
 */
export const GATEWAY_SHUTDOWN_KILL_ALARM_COUNT = 256

/**
 * WHAT THE SHUTDOWN OBSERVED about one generation when it reached it.
 *
 * THREE VALUES FOR THREE STATES, and the third is why this field exists. The domain
 * is: we killed it / it was already gone / we could not tell — plus a FOURTH state,
 * "the shutdown never reached this generation at all", which is the ABSENCE of an
 * entry. An earlier revision encoded the domain as entry-present vs entry-absent, so
 * `undetermined` shared its representation with `ordinary crash`, and the next tick
 * read it as the neighbour it resembled: a confident `child-died`. A field that cannot
 * express "I looked and could not tell" has that state read as whichever neighbour it
 * looks like, and here that was the worst one.
 */
export type GatewayShutdownObservation =
  /** Observed ALIVE when the shutdown reached it, and the kill then RETURNED. A deploy
   *  killed it. The only value that attributes a death to the shutdown. */
  | 'alive-and-killed'
  /**
   * Observed ALIVE when the shutdown reached it, and what the kill did is NOT
   * ESTABLISHED — it threw, or this process stopped before it could record the outcome.
   *
   * THE PRE-KILL STATE, and it exists so that no record written before the act can
   * assert the act. `alive-and-killed` is only ever reached by
   * {@link confirmShutdownKill} AFTER `kill()` returns; until then the row says this,
   * which is true at the moment it is written and attributes nothing. A process that
   * dies mid-shutdown therefore leaves an honest "cause not established" rather than
   * either silence or a deploy claim nothing performed.
   */
  | 'alive-when-reached'
  /** Already gone when the shutdown reached it — so the shutdown did NOT kill it, and
   *  nothing here establishes what did. */
  | 'already-gone'
  /** The liveness probe itself failed: we could not even look. Distinct from
   *  `already-gone`, because "it was dead" and "I could not check" are different
   *  facts and only one is an observation. */
  | 'could-not-sample'

/** One child generation the gateway shutdown reached on this session key. */
export interface GatewayShutdownKillEntry {
  /** The `child_generation` this entry is about. */
  generation: string
  /** What the shutdown established about it. REQUIRED: an entry whose `observed` is
   *  absent or unrecognised is refused by `gatewayShutdownKillEntryFor` and is evidence
   *  of nothing. Optional in the TYPE only because a row read off disk is not a trusted
   *  type boundary — the validator, not the type, is what enforces it. */
  observed?: GatewayShutdownObservation
  /** Epoch ms the kill was recorded — before the kill, by the process making it. */
  at: number
  /** The OS pid of that generation's child.
   *
   *  CARRIED SO A LATER READER CAN CONFIRM THE DEATH INSTEAD OF TAKING THIS ENTRY'S
   *  WORD FOR IT. The entry is written BEFORE `kill()`, and `kill()` can throw or the
   *  process can die between the two — so the entry records that we INTENDED to kill a
   *  child we had observed alive, which attributes a death without establishing one.
   *  The only thing that knows whether the kill landed is the process table, and for a
   *  SUPERSEDED generation the row's own `pid` field belongs to the replacement, so
   *  the pid has to travel with the entry or the confirmation is impossible.
   *
   *  Absent on an entry written before this field existed: a reader that cannot
   *  confirm reports UNKNOWN rather than assuming either way. */
  pid?: number
  /**
   * WHICH PROCESS THAT PID WAS, sampled from the kernel before the kill.
   *
   * A pid on its own is an identifier, not a handle. This entry stays eligible for four
   * hours ({@link GATEWAY_SHUTDOWN_KILL_RETENTION_MS}) and pids are recycled well inside
   * that on a busy box, so a later reader asking `process.kill(pid, 0)` may be asking
   * about a stranger and cannot tell. `start_ticks` + `boot_id` is the pair the kernel
   * maintains that a recycled pid cannot reproduce — see `process-identity.ts`.
   *
   * Absent where it could not be sampled (no `/proc`: macOS self-host, a container
   * without it) or on an entry from a build before the field existed. A reader without
   * it can still establish a DEATH, but it must not ATTRIBUTE one — the pid look cannot
   * be tied to the process this entry describes.
   */
  identity?: ProcessIdentity
}

/** The spawn-time properties {@link ReplRegistryRecord.reuse} carries. A nested
 *  object rather than three top-level fields: they are one fact about one child —
 *  what it was spawned as — and they are read as a set or not at all. */
export interface ReplReuseProperties {
  /** `session.toolSurface`: the `--tools` value as a stable comma-joined key. An
   *  EMPTY STRING IS A REAL VALUE here (`--tools ""`, the default-deny surface an
   *  untrusted-content REPL gets), never a missing one. */
  tool_surface: string
  /** `session.toolBridgeActive`: was the native-MCP tool bridge attached at spawn. */
  tool_bridge: boolean
  /** `session.authFingerprint`: see {@link ReplRegistryRecord.reuse}. */
  auth_fingerprint: string
}

/** One persisted REPL supervision row. */
export interface ReplRegistryRecord {
  /** Pool key — opaque; follows S3 re-namespacing. */
  sessionKey: string
  /** Session UUID the respawn will `--resume`. */
  sessionId: string
  /** REPL working dir (instance home / project workdir). */
  cwd: string
  /** Dev-channel server name (port-recycle guard echoed by `/health`). */
  channelName: string
  /** True once the session JSONL exists on disk → safe to `--resume`. Set by
   *  consuming `captureSession`'s result (closes the S1 fire-and-forget gap). */
  has_session: boolean
  /** Last-known child pid — liveness probe (`PtyChild.hasExited` is primary;
   *  pid is the cross-restart fallback the watchdog can `kill -0`). */
  pid?: number
  /** Dev-channel HTTP port — `/health` liveness probe target. */
  devchannel_port?: number
  /**
   * #539 — THE DURABLE HANDLE FOR THIS CHILD'S TERMINAL: the herdr pane id, written
   * at spawn, read at the next gateway's boot so a REPL that OUTLIVED its gateway can
   * be found again instead of being spawned over.
   *
   * PRESENT ONLY WHERE THE CHILD OUTLIVES US. A `BunTerminalHost` child is a child of
   * the gateway process and dies with it, so it has no handle and this stays absent —
   * `PtyChild.paneHandle` carries the same fact at runtime and this is its persisted
   * form. Absence therefore means "nothing survives for anyone to adopt", which is
   * exactly what the shutdown path needs in order to keep killing what it must.
   *
   * IT IS CLEARED WHEN A SPAWN REPLACES THE CHILD WITH ONE THAT HAS NO HANDLE
   * (`spawn.ts`), not merely left alone. A row that keeps a handle from a previous,
   * differently-hosted incarnation would send the next boot chasing a pane id that
   * names nothing — or, after a herdr server restarted its pane numbering from
   * scratch, names somebody else's pane. A handle is a claim about the CURRENT child
   * and must not outlive it.
   *
   * IT IS NOT AN IDENTITY. Nothing may adopt on the strength of this field alone: the
   * pane it names has to be re-verified (`orphan-adoption.ts` matches the pane's live
   * argv against this row's `sessionId` AND `channelName`, and the dev-channel's
   * `/health` has to answer with this row's session id). A pane id is an identifier
   * the herdr server issues and can reissue across its own restart, which is the same
   * recycling hazard a pid has and is answered the same way.
   */
  pane_handle?: string
  /**
   * #539 — THE THREE SPAWN-TIME PROPERTIES THE WARM-REUSE GUARDS COMPARE AGAINST,
   * persisted so a RE-ADOPTED session can answer them.
   *
   * WITHOUT THIS THE ADOPTION IS POINTLESS. `getOrSpawnSession` refuses to serve a
   * turn on a warm REPL whose tool surface, bridge attachment or credential
   * fingerprint differ from the request's, and EVICTS it. A session rebuilt from a
   * registry row knows none of the three, so all three compare unequal and the very
   * first turn after the restart destroys the REPL that was just re-adopted — a
   * feature that works right up until something uses it.
   *
   * THEY ARE PROPERTIES OF THE CHILD, WRITTEN BY THE SPAWN THAT MADE IT, in the same
   * write as its pid, generation and pane handle. That is what keeps them from
   * drifting: one child, one row, one write, and a respawn replaces all of it.
   *
   * ON `auth_fingerprint` SPECIFICALLY, since it is derived from a secret: it is the
   * first 16 hex chars of `sha256(<the env auth secret>)` (`authFingerprintFor`) —
   * never the secret, and already the form the in-memory guard compares. The file it
   * lands in is written 0600 in the instance state dir, which is the SAME directory
   * as `sinkTokenPath` — the actual reply-sink secret. So the marginal exposure is a
   * truncated hash stored beside the plaintext key it is a hash of; what it buys is
   * that a rotated token still EVICTS (fingerprints differ) instead of being
   * unanswerable. Empty string where the instance has no env auth secret (the
   * interactive-login model), which is exactly what the in-memory guard holds there.
   */
  reuse?: ReplReuseProperties
  /** Model id the REPL spawned with — replayed on `--resume` so a respawn keeps
   *  the same `--model`. */
  model?: string
  /** Epoch ms the REPL first reached `/health` ok — the boot-grace gate input. */
  first_ready_at?: number
  /** Epoch ms of the last respawn — the cooldown gate input. */
  last_respawn_at?: number
  /** Epoch ms a respawn was marked in-flight — the cross-process double-spawn
   *  guard (the process-local guard is `in-flight-gate.ts`). Cleared on
   *  completion/failure. */
  respawn_in_flight_at?: number
  /** Respawn timestamps inside the rolling window — restart-rate cap input. */
  recent_respawns?: number[]
  /** Epoch ms the hard cap tripped — auto-recovery OFF until an operator clears
   *  it via the admin endpoint. */
  capped_at?: number
  /** Epoch ms at which THIS PID EDGE'S CRASH REPORT WAS CLOSED — i.e. the edge has
   *  been reported and must not be reported a second time. Read by the supervision
   *  watchdog, which skips its crash-sink call when this is set
   *  (`supervision.ts`), and cleared by `spawn.ts` when a new child generation is
   *  written so the next edge reports freely.
   *
   *  TWO WRITERS, and BOTH write it only after a sink call has actually committed:
   *    - the supervision watchdog, after its durable child-crash sink returned;
   *    - the gateway-shutdown kill path (`gateway-shutdown-kill.ts`
   *      → `closeCrashReportEdge`), after its own sink call returned.
   *  It is never set when no sink is wired, and never when a sink threw or was
   *  abandoned on a timeout: no report happened, so the edge stays OPEN and the next
   *  boot is free to report the death. That is what makes the shutdown marker a
   *  backstop rather than a decoration.
   *
   *  IT IS KEYED ON WHETHER A REPORT WAS DELIVERED, NEVER ON WHAT THE REPORT SAID.
   *  A delivered `cause: 'unknown'` ("the launcher is gone and nobody established
   *  why") closes this edge exactly as a delivered deploy attribution does — the
   *  report happened and it said what was true. An earlier revision closed it only
   *  for the attributed case, so an honest undetermined report left the edge open and
   *  the next tick reported the same death again as a confident `child-died`, which
   *  `crashRunningByLauncher` writes over the tombstone unconditionally. Telling the
   *  owner something and telling the owner it was a deploy are different facts, and
   *  only the first one closes this.
   *
   *  The name is for the EDGE, not for the sink, because the watchdog reads it to
   *  answer "is there anything left to say about this death" — but the two are no
   *  longer in tension. An earlier revision of the shutdown path did close this
   *  alongside the marker, before its report, and this docblock described that; both
   *  the behaviour and the sentence were wrong, and the behaviour was fixed first. */
  child_crash_notified_at?: number
  /** Unique ownership token for this spawned child incarnation. */
  child_generation?: string
  /** #518 — every child generation on this session key that a GATEWAY SHUTDOWN
   *  REACHED (`shutdownAllPersistentRepls`, from the SIGTERM handler: a service restart
   *  or a deploy). Written just before each kill, read back so the death is reported as
   *  what was actually established — a deploy, or an honest "cause not established" —
   *  instead of a bare crash. See {@link GatewayShutdownObservation}: an entry records
   *  WHAT WAS OBSERVED, so an undetermined outcome is durable rather than sharing its
   *  representation with an ordinary crash.
   *
   *  A LIST, KEYED BY GENERATION, AND THAT IS THE POINT. One teardown reaches two
   *  generations on one session key: the POOLED child, and a QUARANTINED child that
   *  held this key until a replacement spawned over it. A single scalar pair could
   *  hold only one of them, so the other's death had nowhere durable to go — and a
   *  quarantined child is quarantined precisely BECAUSE it still hosts running
   *  workflows, which makes it the death that matters most.
   *
   *  It also makes the staleness question structural instead of enforced: an entry
   *  names its own generation, so an entry for a superseded child can never be read
   *  as describing the current one. `spawn.ts` therefore does NOT clear this on a
   *  respawn — it must outlive the generation it describes, which is the whole
   *  reason it exists.
   *
   *  Growth is bounded by the retention window, not by a count: one entry
   *  accrues per shutdown that killed a child on this key, and the only consumer is
   *  a still-in-flight build asking about its own launcher — bounded by trident's
   *  2-hour in-flight ceiling, so older entries are unreachable by construction. */
  killed_by_gateway_shutdown?: GatewayShutdownKillEntry[]
}

/** All records keyed by `sessionKey`. */
export type ReplRegistry = Record<string, ReplRegistryRecord>

/** Result of parsing the on-disk registry file. */
export type RegistryLoadResult =
  | { kind: 'absent' }
  | { kind: 'loaded'; registry: ReplRegistry }
  | { kind: 'corrupt'; reason: string }

// ─── Pure (de)serialization ────────────────────────────────────────────────

/** Parse raw file contents into a registry. Pure — does no IO. A single
 *  malformed row is dropped rather than poisoning the whole registry.
 *  `onDropRow`, if given, is invoked for every row that fails the schema
 *  check (e.g. one written by an older/newer build during a rolling
 *  restart) so the drop is at least observable instead of silent — the row
 *  itself is still dropped (a half-shaped record isn't safely usable). Its
 *  third argument is the FULL raw file text (not just the one row) so a
 *  caller can sidecar-preserve the whole pre-drop file, not just the one
 *  malformed row, before the drop becomes permanent on save. */
export function parseRegistryContents(
  contents: string,
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void,
): RegistryLoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (e) {
    return { kind: 'corrupt', reason: `json-parse-error: ${(e as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'not-an-object' }
  }
  const registry: ReplRegistry = {}
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMinimalRecord(raw)) {
      onDropRow?.(key, raw, contents)
      continue
    }
    const rec = raw as ReplRegistryRecord
    // Trust the on-disk sessionKey field; fall back to the map key.
    registry[key] = { ...rec, sessionKey: rec.sessionKey || key }
  }
  return { kind: 'loaded', registry }
}

/** Serialize a registry to disk-ready JSON. Pretty-printed for grep-ability. */
export function serializeRegistry(registry: ReplRegistry): string {
  return JSON.stringify(registry, null, 2)
}

function isMinimalRecord(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return (
    typeof r.sessionId === 'string' &&
    typeof r.cwd === 'string' &&
    typeof r.channelName === 'string' &&
    typeof r.has_session === 'boolean'
  )
}

// ─── Disk-touching wrappers ────────────────────────────────────────────────

/** Load the registry file. Returns `{}` on absent or corrupt (the steady-state
 *  cold-boot case). Corruption is logged via `onCorrupt` so the caller can
 *  observe it without this function throwing — a corrupt registry must never
 *  brick the substrate. `onCorrupt`'s second argument carries the raw file
 *  contents when they were readable (i.e. every case except a read error) so
 *  a caller can sidecar-copy them before they're lost. `onDropRow` reports
 *  individual rows dropped for failing the schema check even when the file
 *  as a whole parses fine.
 *
 * Classifies "absent" by `ENOENT` on the read itself rather than a separate
 * `existsSync` pre-check (Codex r6): a pre-check-then-read has a TOCTOU gap,
 * AND `existsSync` collapses ANY stat error — not just "doesn't exist" — to
 * `false` (e.g. a permission-denied parent directory), which would silently
 * misclassify a genuine read failure as the steady-state absent case. */
export function loadRegistry(
  path: string,
  onCorrupt?: (reason: string, rawContents?: string) => void,
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void,
): ReplRegistry {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {} // absent — steady-state cold boot
    onCorrupt?.(`read-error: ${(e as Error).message}`)
    return {}
  }
  const result = parseRegistryContents(contents, onDropRow)
  if (result.kind === 'loaded') return result.registry
  if (result.kind === 'corrupt') onCorrupt?.(result.reason, contents)
  return {}
}

/**
 * Load for the MUTATION path specifically (`withRegistry`) — like
 * `loadRegistry`, but additionally reports whether the save that's about to
 * follow should be SKIPPED.
 *
 * A whole-file READ error (EACCES, EMFILE, a transient NFS hiccup, ...) is
 * fundamentally different from a PARSE error: on a parse error we DID get
 * the bytes (just couldn't make sense of them), so proceeding to rebuild +
 * save is safe — the original is sidecar-preserved either way. On a read
 * error we got NOTHING, so we have no idea whether the on-disk file was
 * fine, transiently inaccessible, or genuinely bad — and no bytes to
 * sidecar even if we wanted to. Proceeding to save a mutation built on `{}`
 * would silently convert a possibly-momentary hiccup into PERMANENT,
 * unrecoverable loss of every row (Codex r4). So on a read error the
 * mutation still runs (callers always get a `T` back, same as any other
 * no-record case) but `skipSave` tells `withRegistry` to leave the on-disk
 * file untouched — whatever state it was in, the next tick gets to retry
 * the read rather than this tick permanently erasing it.
 *
 * Classifies "absent" by `ENOENT` on the read itself, same as `loadRegistry`
 * (Codex r6) — a separate `existsSync` pre-check has a TOCTOU gap and would
 * fold a genuine (non-ENOENT) read failure into the "absent" `skipSave:
 * false` branch, defeating the very protection this function exists to add.
 */
function loadRegistryForMutation(
  path: string,
  onCorrupt: (reason: string, rawContents?: string) => void,
  onDropRow: (key: string, raw: unknown, rawContents: string) => void,
): { registry: ReplRegistry; skipSave: boolean } {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { registry: {}, skipSave: false }
    onCorrupt(`read-error: ${(e as Error).message}`)
    return { registry: {}, skipSave: true }
  }
  const result = parseRegistryContents(contents, onDropRow)
  if (result.kind === 'loaded') return { registry: result.registry, skipSave: false }
  if (result.kind === 'corrupt') onCorrupt(result.reason, contents)
  return { registry: {}, skipSave: false }
}

/** Atomically write the registry to disk (tmp → fsync → rename). */
export function saveRegistry(path: string, registry: ReplRegistry): void {
  atomicWriteFileSync(path, serializeRegistry(registry))
}

/**
 * Read the record for `sessionKey`, or undefined.
 *
 * `model` IS COERCED HERE, AT THE ONE READER, AND NOT AT THE EIGHT CALL SITES.
 * The field is declared `model?: string` above and never schema-checked, while
 * every consumer spends it the same way — `record?.model ?? getBestModel()`
 * (`pool.ts:176` is the shared one) — straight into a child's `--model` argv. A
 * `??` only catches `null`/`undefined`, so a row carrying a number or an object
 * (a hand-edit, a foreign build, a partial write) would be handed to the CLI
 * verbatim by seven profiles that have no floor in front of them. Reducing an
 * UNUSABLE value to absent makes every one of those `??` fall back to the best
 * model, which is what each of them already meant.
 *
 * The record is only copied on that abnormal branch, so the normal read still
 * returns the loaded object untouched.
 */
export function getRecord(path: string, sessionKey: string): ReplRegistryRecord | undefined {
  const record = loadRegistry(path)[sessionKey]
  if (record === undefined) return undefined
  if (record.model === undefined) return record
  if (typeof record.model === 'string' && record.model.trim() !== '') return record
  const { model: _unusable, ...rest } = record
  return rest
}

// Per-process monotonic counter so two sidecars written in the SAME
// millisecond (a corrupt full-file save racing a dropped-row save, or two
// watchdog ticks in tight succession) never PICK the same candidate path —
// mirrors `atomic-write.ts`'s `stagingPathFor` pid+counter pattern. The `wx`
// exclusive-create flag below is the actual guarantee (this counter is just
// what keeps the retry loop from needing more than one attempt in practice);
// without EITHER, a same-millisecond second write could silently
// `writeFileSync`-truncate the first recovery copy or follow a pre-existing
// symlink at that path, defeating the whole point of the sidecar.
let sidecarCounter = 0

/** TEST-ONLY: reset the monotonic sidecar-naming counter to 0 so a test can
 *  predict exact candidate sidecar paths (combined with overriding
 *  `Date.now`) and deterministically exercise the `EEXIST`-retry / retry-
 *  exhaustion boundaries without relying on real OS permission bits — which
 *  a root-run CI container bypasses entirely, silently skipping coverage of
 *  those paths (Codex r7). NEVER call this outside tests. */
export function __resetSidecarCounterForTests(): void {
  sidecarCounter = 0
}

/** Ceiling on `EEXIST` retries — defends against a hostile/corrupted
 *  directory that's pre-populated every candidate path; a real collision
 *  resolves on attempt 1 essentially always (pid+counter+ms is already
 *  unique in the overwhelmingly common case). Exported read-only so tests
 *  can exercise the exhaustion boundary without hardcoding the number twice. */
export const SIDECAR_MAX_ATTEMPTS = 5

/** Best-effort preserve a corrupt/pre-drop registry's raw bytes to a
 *  collision-resistant sidecar file next to `path`, so an operator can
 *  hand-recover rows a save is about to drop. Uses exclusive create (`wx`) —
 *  refuses to touch an existing path (including a symlink planted there)
 *  rather than silently overwriting/following it — and retries with a fresh
 *  suffix on `EEXIST` instead of ever falling back to a non-exclusive write.
 *  Never throws — a sidecar-write failure must not block the mutation
 *  already in flight inside the lock. */
function writeSidecarBestEffort(path: string, contents: string): string | undefined {
  let lastErr: unknown
  for (let attempt = 0; attempt < SIDECAR_MAX_ATTEMPTS; attempt++) {
    const sidecarPath = `${path}.corrupt-${Date.now()}-${process.pid}-${sidecarCounter++}`
    try {
      writeFileSync(sidecarPath, contents, { mode: 0o600, flag: 'wx' })
      return sidecarPath
    } catch (e) {
      lastErr = e
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue // fresh suffix, retry
      log.error('sidecar_write_failed', { sidecar: sidecarPath, error: String(e) })
      return undefined
    }
  }
  // Event text preserves the 'EEXIST retries' substring a regression test pins.
  log.error('EEXIST retries exhausted — sidecar write gave up', {
    path,
    attempts: SIDECAR_MAX_ATTEMPTS,
    error: String(lastErr),
  })
  return undefined
}

/**
 * Default `onCorrupt` handler for the mutation path (`withRegistry` and
 * everything built on it: `upsertRecord`/`patchRecord`/`removeRecord`).
 *
 * Unlike the read-only diagnostics path (`gateway/diagnostics/instance-sources.ts`,
 * which THROWS so an unreadable registry surfaces as `available: false`), the
 * mutation path must never crash the gateway on corruption — a watchdog tick
 * that can't tolerate a bad registry file would take down supervision for
 * every OTHER project too. So this degrades LOUD-but-alive instead.
 *
 * Branches on TWO distinct failure shapes that must NOT share a message
 * (Codex r6 — the shared message previously falsely told operators a
 * whole-file read error was "about to rebuild ... DROPS every other row",
 * when a read error's `skipSave` actually means NOTHING is committed):
 *   - a whole-file READ error (`reason` starts with `read-error:`): NOTHING
 *     is sidecar-preserved (there are no bytes to preserve) because NOTHING
 *     is being overwritten either — `loadRegistryForMutation` sets
 *     `skipSave` for this case, so the on-disk file is left completely
 *     untouched. The log says exactly that.
 *   - a genuine PARSE/shape error (bytes WERE read, just didn't parse): the
 *     mutation DOES proceed to rebuild `path` from `{}`, so this branch logs
 *     the sidecar it best-effort writes BEFORE that rebuild, so every other
 *     sessionKey's row is recoverable by hand even though it's about to be
 *     dropped from the live file.
 * An ABSENT file never reaches this — `loadRegistry` returns `{}` for that
 * case without invoking `onCorrupt` at all (the steady-state cold-boot path).
 */
function defaultCorruptHandler(path: string): (reason: string, rawContents?: string) => void {
  return (reason, rawContents) => {
    if (reason.startsWith('read-error:')) {
      // Event text preserves the substrings a regression test pins
      // ('READ ERROR', 'SKIPPED', 'Nothing was dropped').
      log.error('READ ERROR — the SAVE is being SKIPPED entirely; on-disk file left untouched. Nothing was dropped.', {
        path,
        reason,
      })
      return
    }
    const sidecarPath = rawContents !== undefined ? writeSidecarBestEffort(path, rawContents) : undefined
    log.error('CORRUPT registry rebuild', {
      path,
      reason,
      sidecar: sidecarPath ?? null,
      sidecar_failed: sidecarPath === undefined,
      // Preserve the substring a regression test pins on the sidecar-failure path.
      recovery: sidecarPath
        ? `Raw bytes preserved at ${sidecarPath} for manual recovery.`
        : 'Sidecar preservation FAILED — raw bytes may be lost.',
    })
  }
}

/**
 * Default `onDropRow` handler — a row dropped for failing the schema check
 * (e.g. missing `has_session`/`channelName`, written by an older/newer build
 * during a rolling restart) is JUST as lossy as whole-file corruption: it's
 * still gone from the registry the mutation is about to save. So this mirrors
 * `defaultCorruptHandler`: logs loudly AND best-effort sidecars the
 * PRE-DROP file bytes before the row disappears for good.
 *
 * A single `loadRegistry` pass can drop multiple rows (e.g. two stale rows
 * from the same bad deploy); this handler sidecars only ONCE per pass — the
 * closure-local `sidecarPath`/`attempted` below are scoped to one call of
 * `defaultDropRowHandler(path)`, and `withRegistry` makes exactly one such
 * call per mutation, so N drops in one load still produce ONE recovery file
 * (all the dropped rows' original bytes are in that one copy of the whole
 * file — no need for N).
 */
function defaultDropRowHandler(path: string): (key: string, raw: unknown, rawContents: string) => void {
  let attempted = false
  let sidecarPath: string | undefined
  return (key, _raw, rawContents) => {
    if (!attempted) {
      attempted = true
      sidecarPath = writeSidecarBestEffort(path, rawContents)
    }
    log.error(`dropping row sessionKey=${key} (schema skew)`, {
      path,
      sidecar: sidecarPath ?? null,
      sidecar_failed: sidecarPath === undefined,
    })
  }
}

/** Options accepted by `withRegistry` and the mutation helpers built on it. */
export interface WithRegistryOptions {
  /** Called IN ADDITION to (never instead of) the mandatory default —
   *  `defaultCorruptHandler`'s loud log + best-effort sidecar ALWAYS run
   *  first, unconditionally, on every corruption event. This is purely an
   *  extra side-channel notification hook (tests observing that corruption
   *  fired; a caller wanting its own additional alerting) — there is
   *  deliberately no way to pass an option that SILENCES or REPLACES the
   *  default, because corruption recovery must never be optional. */
  onCorrupt?: (reason: string, rawContents?: string) => void
  /** Called IN ADDITION to (never instead of) the mandatory default —
   *  `defaultDropRowHandler`'s loud log + best-effort sidecar. Same
   *  additive-only contract as `onCorrupt`. */
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void
}

/**
 * Lock-guarded read-modify-write. `mutate` receives the CURRENT on-disk
 * registry (re-read inside the lock so concurrent ticks compose) and returns
 * the registry to persist. Returns whatever `mutate` returns as the second
 * tuple element so callers can observe the result of the critical section
 * (e.g. "did I win the in-flight claim?").
 *
 * Corruption never aborts the mutation (boot resilience — a corrupt registry
 * must not brick the gateway) but is always LOUD: `defaultCorruptHandler` /
 * `defaultDropRowHandler` run UNCONDITIONALLY on every corruption/drop event;
 * `options.onCorrupt` / `options.onDropRow`, if given, run in ADDITION —
 * never as a replacement (Codex r3: a caller-supplied callback must not be
 * able to silently disable the sidecar safety net).
 *
 * A whole-file READ error (as opposed to a parse/shape error) skips the SAVE
 * entirely — `mutate` still runs and the caller still gets its `T`, but
 * nothing is written to disk, leaving the file exactly as it was for the
 * next tick to retry (Codex r4: we have no bytes to sidecar and no way to
 * know the failure wasn't transient, so committing a `{}`-based mutation
 * would risk turning a momentary hiccup into permanent, unrecoverable loss).
 * See `loadRegistryForMutation`.
 */
/**
 * Read the registry UNDER THE LOCK, without writing it back (#539).
 *
 * WHY THIS IS NOT `getRecord`. `getRecord` takes no lock at all, so a caller that
 * reads with it and then ACTS on what it read has its decision ordered against a
 * concurrent writer by nothing whatsoever. For a caller whose action is "leave a
 * process running", that is the difference between a decision and a guess: the
 * gateway-shutdown survival gate (`gateway-shutdown-survival.ts`) must not leave a
 * pane alive on the strength of a row another incarnation has already replaced.
 * Taking the same flock every writer takes serialises the two — the writer's change
 * lands strictly before or strictly after the decision, never inside it.
 *
 * It does NOT save, which is the whole point of having it rather than a `withRegistry`
 * whose mutate returns its input: a byte-identical rewrite of every row is a write
 * this path has no business performing while the process is shutting down.
 */
export function withRegistryRead<T>(path: string, read: (registry: ReplRegistry) => T): T {
  return withFlockSync(registryLockPath(path), () => read(loadRegistry(path)))
}

export function withRegistry<T>(
  path: string,
  mutate: (registry: ReplRegistry) => { registry: ReplRegistry; result: T },
  options: WithRegistryOptions = {},
): T {
  const mandatoryOnCorrupt = defaultCorruptHandler(path)
  const mandatoryOnDropRow = defaultDropRowHandler(path)
  // The mandatory default ALWAYS runs, unguarded — if that itself throws,
  // something is deeply wrong and we want it loud. The CALLER-supplied
  // callback, in contrast, is untrusted: it must NEVER be able to abort the
  // mutation by throwing (Codex r5) — that would violate "corruption never
  // aborts the mutation" for the one case (options.onCorrupt/onDropRow) that
  // isn't under this module's control. Isolate it in its own try/catch.
  const onCorrupt = (reason: string, rawContents?: string): void => {
    mandatoryOnCorrupt(reason, rawContents)
    try {
      options.onCorrupt?.(reason, rawContents)
    } catch (e) {
      log.error('caller-supplied onCorrupt callback threw (ignored)', { error: String(e) })
    }
  }
  const onDropRow = (key: string, raw: unknown, rawContents: string): void => {
    mandatoryOnDropRow(key, raw, rawContents)
    try {
      options.onDropRow?.(key, raw, rawContents)
    } catch (e) {
      log.error('caller-supplied onDropRow callback threw (ignored)', { error: String(e) })
    }
  }
  return withFlockSync(registryLockPath(path), () => {
    const { registry: current, skipSave } = loadRegistryForMutation(path, onCorrupt, onDropRow)
    const { registry, result } = mutate(current)
    if (!skipSave) saveRegistry(path, registry)
    return result
  })
}

/** Upsert one record (lock-guarded). Merges onto any existing row so a
 *  concurrent tick's fields survive. */
export function upsertRecord(
  path: string,
  record: ReplRegistryRecord,
  options?: WithRegistryOptions,
): void {
  withRegistry(
    path,
    (registry) => {
      const prev = registry[record.sessionKey]
      registry[record.sessionKey] = prev ? { ...prev, ...record } : record
      return { registry, result: undefined }
    },
    options,
  )
}

/** Patch specific fields on a record (lock-guarded). No-op if the row is gone. */
export function patchRecord(
  path: string,
  sessionKey: string,
  patch: Partial<ReplRegistryRecord>,
  options?: WithRegistryOptions,
): void {
  withRegistry(
    path,
    (registry) => {
      const prev = registry[sessionKey]
      if (prev) registry[sessionKey] = { ...prev, ...patch }
      return { registry, result: undefined }
    },
    options,
  )
}

/** Remove a record (lock-guarded). Idempotent. */
export function removeRecord(path: string, sessionKey: string, options?: WithRegistryOptions): void {
  withRegistry(
    path,
    (registry) => {
      delete registry[sessionKey]
      return { registry, result: undefined }
    },
    options,
  )
}
