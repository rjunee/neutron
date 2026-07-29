/**
 * @neutronai/gbrain-memory — GBrain upstream version-notice (notify mode).
 *
 * GBrain ships an invocation-riding self-upgrade (`gbrain` `src/core/
 * self-upgrade.ts`). On a minor/major upstream bump it emits a marker on the
 * `gbrain serve` child's **stderr**:
 *
 *     UPGRADE_AVAILABLE <current> <latest>
 *     gbrain <current> -> <latest> available. Run: gbrain self-upgrade
 *
 * Neutron runs GBrain in **notify** mode only — never silent auto-upgrade
 * inside a customer instance. A memory-substrate schema change mid-session is
 * exactly the kind of volatile state the owner must gate, so we surface a
 * one-line notice in the admin "Memory" tab and let the owner decide when to
 * run the upgrade. This mirrors how Neutron tracks Claude Code / Codex
 * substrate versions (cf. Nova's cc-update-doctor).
 *
 * Pure parsing here; the stdio client wires `parseUpgradeMarker` to the
 * child's stderr stream and a `GBrainVersionNotice` holds the latest result.
 */

/** Notify-mode is the only mode Neutron uses inside an instance. */
export type GBrainUpgradeMode = 'notify' | 'off'

export interface GBrainUpgradeNotice {
  current: string
  latest: string
}

/** Strict semver-ish version token (GBrain uses 4-segment MAJOR.MINOR.PATCH.MICRO). */
const VERSION_TOKEN = /^[0-9]+(\.[0-9]+){1,3}$/

/**
 * Parse a single stderr line for GBrain's `UPGRADE_AVAILABLE` marker. Returns
 * the `{ current, latest }` pair, or `null` for any non-marker line.
 *
 * Defensive on purpose — the line arrives from a child process's stderr, so a
 * malformed / partial / spoofed line must yield `null`, never throw. We
 * validate both tokens look like versions so an arbitrary stderr line that
 * happens to start with the marker word can't forge an upgrade notice.
 */
export function parseUpgradeMarker(line: string): GBrainUpgradeNotice | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length !== 3) return null
  if (parts[0] !== 'UPGRADE_AVAILABLE') return null
  const current = parts[1] ?? ''
  const latest = parts[2] ?? ''
  if (!VERSION_TOKEN.test(current) || !VERSION_TOKEN.test(latest)) return null
  return { current, latest }
}

/**
 * Holds the latest GBrain upgrade notice observed from a `gbrain serve`
 * child's stderr. Feed it raw stderr chunks; read the current notice for the
 * admin "Memory" tab. In `off` mode it ignores all markers.
 */
export class GBrainVersionNotice {
  private readonly mode: GBrainUpgradeMode
  private notice: GBrainUpgradeNotice | null = null
  private buffer = ''

  constructor(mode: GBrainUpgradeMode = 'notify') {
    this.mode = mode
  }

  /**
   * Feed a raw stderr chunk (may contain partial lines). Splits on newlines,
   * parses each complete line, and records the most recent upgrade notice.
   */
  ingestStderr(chunk: string): void {
    if (this.mode === 'off') return
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const parsed = parseUpgradeMarker(line)
      if (parsed !== null) this.notice = parsed
    }
  }

  /** The latest upgrade notice, or `null` if GBrain is up to date / mode off. */
  current(): GBrainUpgradeNotice | null {
    return this.notice
  }
}
