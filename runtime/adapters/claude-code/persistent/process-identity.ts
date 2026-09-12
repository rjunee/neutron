/**
 * A PID IS AN IDENTIFIER, NOT A HANDLE — and this module is what closes the gap.
 *
 * Everything in `gateway-shutdown-kill.ts` that confirms a death confirms it against a
 * stored number, and a number is only as good as the process still standing behind it.
 * Kernel pids are recycled: a gateway-shutdown entry stays eligible for
 * `GATEWAY_SHUTDOWN_KILL_RETENTION_MS` (four hours), which on a busy box is ample time
 * for the pid of a killed launcher to be handed to something unrelated. A reader that
 * asks `process.kill(pid, 0)` then learns about THAT process, not ours, and cannot tell
 * the difference — so it either calls a dead launcher alive (the multi-hour hang this
 * item exists to remove) or reasons about a stranger's lifetime as though it were the
 * launcher's.
 *
 * The fix is to store, alongside the pid, something the kernel maintains and cannot be
 * reissued with it:
 *
 *   - `start_ticks` — field 22 of `/proc/<pid>/stat`, the process's start time in clock
 *     ticks since boot. A recycled pid gets a later start time; equality means the pid
 *     still names the process we recorded.
 *   - `boot_id` — `/proc/sys/kernel/random/boot_id`, regenerated on every boot. Start
 *     ticks are measured FROM boot, so two processes from different boots can share a
 *     pid AND a start time. Without the boot id the comparison silently compares two
 *     different clocks; with it, a record from another boot is refused as
 *     `not-comparable` rather than answered wrongly.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: invent an identity when one cannot be read. Every
 * reader here can answer "I could not establish it", because `false` and `unknown` must
 * not share a branch — the rule this item has now hit in three places. A host without
 * `/proc` (macOS self-host, a container without it mounted) records no identity and its
 * readers fall back to a WEAKER verdict, never to a confident one.
 */

import { readFileSync } from 'node:fs'

/** A pid plus the kernel facts that say WHICH process had it. Snake-case because it is
 *  persisted verbatim into the JSON registry alongside the rest of the row. */
export interface ProcessIdentity {
  /** `/proc/<pid>/stat` field 22 — start time in clock ticks since boot. */
  start_ticks: number
  /** `/proc/sys/kernel/random/boot_id` — the boot those ticks are counted from. */
  boot_id: string
}

/** Seam for tests: both reads are plain files, so a test supplies its own reader rather
 *  than needing a real recycled pid (which cannot be arranged on demand). */
export interface ProcIdentityDeps {
  readFile?: (path: string) => string
}

const read = (deps: ProcIdentityDeps | undefined, path: string): string =>
  (deps?.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path)

/** The current boot's id, or `undefined` where it cannot be read (non-Linux). */
export function currentBootId(deps?: ProcIdentityDeps): string | undefined {
  try {
    const raw = read(deps, '/proc/sys/kernel/random/boot_id').trim()
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * The identity of a LIVE pid, or `undefined` when it cannot be established — the pid is
 * gone, `/proc` is not there, or the line does not parse.
 *
 * The `comm` field is untrusted: a process can name itself `foo) 1 2 3` and shift every
 * field after it. Parsing therefore starts after the LAST `)` in the line, which is what
 * the kernel's own documentation prescribes.
 */
export function readProcessIdentity(pid: number, deps?: ProcIdentityDeps): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const boot_id = currentBootId(deps)
  if (boot_id === undefined) return undefined
  let stat: string
  try {
    stat = read(deps, `/proc/${pid}/stat`)
  } catch {
    return undefined
  }
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  // Fields after `comm` start at field 3 (state), so field 22 is index 19.
  const raw = fields[19]
  if (raw === undefined) return undefined
  const start_ticks = Number.parseInt(raw, 10)
  if (!Number.isInteger(start_ticks) || start_ticks < 0) return undefined
  return { start_ticks, boot_id }
}

/** Validate an identity read back off disk. A registry row is not a trusted type
 *  boundary, and a half-shaped identity must degrade to "none" rather than to a
 *  comparison against `undefined` that happens to succeed. */
export function isProcessIdentity(v: unknown): v is ProcessIdentity {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Partial<ProcessIdentity>
  return typeof o.start_ticks === 'number' && Number.isInteger(o.start_ticks) && typeof o.boot_id === 'string' && o.boot_id.length > 0
}

/**
 * What a stored pid + identity can still be said to establish.
 *
 *   - `ours-alive`      the pid is live AND is the process we recorded.
 *   - `confirmed-gone`  the process we recorded is positively no longer running.
 *   - `not-comparable`  the record is from ANOTHER BOOT: its pid is not comparable with
 *                       this boot's, and the process behind it cannot be running.
 *   - `unverifiable`    no stored identity, an unreadable one, or a live pid we cannot
 *                       identify: the look happened and established nothing.
 */
export type RecordedPidVerdict = 'ours-alive' | 'confirmed-gone' | 'not-comparable' | 'unverifiable'

export interface RecordedPidDeps extends ProcIdentityDeps {
  /** Defaults to `process.kill(pid, 0)`. */
  signal?: (pid: number) => void
}

/**
 * Classify a pid recorded earlier, using the identity stored beside it.
 *
 * The two live branches are where recycling actually bites, and they answer opposite
 * questions from the SAME observation ("a process holds this pid"):
 *
 *   - identity matches → it is ours and it is running.
 *   - identity differs → the pid has been reissued, which is itself positive evidence
 *     that our process exited: a running process keeps its pid.
 *
 * The absent branch is airtight WITHIN A BOOT and only there: a live process holds its
 * pid, so a pid nothing holds cannot belong to a live process of ours. Across boots the
 * comparison is meaningless, which is what `boot_id` is for.
 *
 * With no stored identity this returns `unverifiable` even when the pid is gone. The pid
 * may have been reissued and released again between the kill and this look, so the
 * absence is an observation about a number rather than about our process — and callers
 * must be able to tell "I established a death" from "I found nothing".
 */
export function classifyRecordedPid(
  pid: number | undefined,
  identity: unknown,
  deps?: RecordedPidDeps,
): RecordedPidVerdict {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unverifiable'
  if (!isProcessIdentity(identity)) return 'unverifiable'
  const boot = currentBootId(deps)
  // NO BOOT ID AND A DIFFERENT BOOT ID ARE DIFFERENT ANSWERS, and collapsing them is the
  // `false`/`unknown` conflation this item has already paid for twice. A DIFFERENT boot
  // id says the recorded process cannot still be running (nothing survives a reboot); an
  // UNREADABLE one says only that this host cannot answer, and a live process may well
  // be standing behind that pid.
  if (boot === undefined) return 'unverifiable'
  if (boot !== identity.boot_id) return 'not-comparable'
  const signal = deps?.signal ?? ((p: number) => process.kill(p, 0))
  let live: boolean
  try {
    signal(pid)
    live = true
  } catch (err) {
    // EPERM is positive evidence the pid EXISTS under another uid — same reading as a
    // successful signal, and the identity read below is what tells them apart.
    live = (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
  if (!live) return 'confirmed-gone'
  const now = readProcessIdentity(pid, deps)
  if (now === undefined) return 'unverifiable'
  // ONE BOOT COMPARISON, ABOVE, AND NOT A SECOND ONE HERE. `now.boot_id` is the same
  // `currentBootId()` already checked, so re-comparing it can never fail — and a check
  // that cannot fail MASKS the one that can: with it in place, deleting the real boot
  // guard above left every case green.
  return now.start_ticks === identity.start_ticks ? 'ours-alive' : 'confirmed-gone'
}
