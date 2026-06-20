/**
 * pty-noise.ts — DCS escape + carriage-return strip for PTY output.
 *
 * LIFTED VERBATIM from Nova `gateway/pty-spawn.ts` (`stripPtyNoise` /
 * `newDcsStripState` / `DcsStripState`). The logic is pure and substrate-
 * independent — it cleans the raw byte stream a PTY master emits before it
 * lands in the per-session liveness ring buffer (§ Sprint-1 deliverable #1).
 *
 * Why we still need it after dropping tmux + the libc FFI: the interactive
 * `claude` REPL is an Ink/React TUI. Its PTY output is full of cursor-motion
 * escapes, line-wrap CRs, and — when ever run nested — DCS wrappers. We never
 * parse the TUI output for the *answer* (that flows out-of-band via the
 * `reply` dev-channel tool → completion Event), but we DO keep a small ring
 * buffer of recent output for (a) liveness diagnostics and (b) the Sprint-2
 * login/banner watchdogs. Stripping CR + DCS keeps that buffer greppable.
 *
 * Ported as-is so `pty-spawn.test.ts`'s split-chunk ESC-buffering cases port
 * verbatim against the Bun-terminal backend.
 */

/**
 * Strip state, threaded across chunk boundaries. The `pending-esc` state
 * buffers a lone ESC byte that arrived at the end of a chunk so a `\x1bP` DCS
 * introducer split across two `data` callbacks is still recognised as DCS,
 * not leaked to the consumer.
 */
export interface DcsStripState {
  dcs: 'idle' | 'pending-esc' | 'in-introducer' | 'in-dcs' | 'in-st'
}

export function newDcsStripState(): DcsStripState {
  return { dcs: 'idle' }
}

/**
 * Strip carriage returns and DCS escape wrappers (`\x1bP…\x1b\`) in-place
 * into a fresh `Uint8Array`. Stateful across chunk boundaries via `state.dcs`.
 * Exported for unit testing.
 */
export function stripPtyNoise(chunk: Uint8Array, state: DcsStripState): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i] ?? 0
    if (state.dcs === 'in-introducer') {
      // We just saw `\x1bP`; consume bytes until the final char (any letter
      // 0x40-0x7e) which closes the introducer.
      if (b >= 0x40 && b <= 0x7e) state.dcs = 'in-dcs'
      continue
    }
    if (state.dcs === 'in-dcs') {
      // Look for ST: `\x1b\\` (ESC + backslash).
      if (b === 0x1b) {
        state.dcs = 'in-st'
        continue
      }
      if (b === 0x0d) continue // strip CR inside DCS too
      out.push(b)
      continue
    }
    if (state.dcs === 'in-st') {
      // Saw ESC inside DCS; if next byte is `\`, ST closes DCS.
      if (b === 0x5c) {
        state.dcs = 'idle'
        continue
      }
      // ESC was stray inside DCS — drop the ESC, treat current byte as
      // continued payload.
      state.dcs = 'in-dcs'
      if (b === 0x0d) continue
      out.push(b)
      continue
    }
    if (state.dcs === 'pending-esc') {
      // Previous chunk ended with a lone ESC. If this byte is `P` (0x50) the
      // buffered ESC + this `P` are a DCS introducer split across chunks.
      if (b === 0x50) {
        state.dcs = 'in-introducer'
        continue
      }
      state.dcs = 'idle'
      out.push(0x1b)
      if (b === 0x0d) continue
      if (b === 0x1b) {
        if (i + 1 < chunk.length) {
          if (chunk[i + 1] === 0x50) {
            i++
            state.dcs = 'in-introducer'
            continue
          }
          out.push(b)
          continue
        }
        state.dcs = 'pending-esc'
        continue
      }
      out.push(b)
      continue
    }
    // idle
    if (b === 0x1b) {
      if (i + 1 < chunk.length) {
        if (chunk[i + 1] === 0x50) {
          i++ // skip the P (then for-loop ++ moves past)
          state.dcs = 'in-introducer'
          continue
        }
        out.push(b)
        continue
      }
      // ESC at end of chunk — buffer until next chunk arrives.
      state.dcs = 'pending-esc'
      continue
    }
    if (b === 0x0d) continue
    out.push(b)
  }
  return Uint8Array.from(out)
}
