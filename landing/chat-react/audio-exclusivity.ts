/**
 * ONE CLIP AT A TIME, for the web chat client.
 *
 * Voice notes render as independent `<audio controls>` elements, and a browser
 * will happily play every one of them at once — start a second while the first
 * is running and the two talk over each other. That is the first thing anyone
 * notices in a chat client that got this wrong, and no single bubble can prevent
 * it: each element knows only about itself.
 *
 * So the rule lives here, in the one place every bubble can reach. The mobile
 * client enforces the same rule with the same shape
 * (`app/lib/voice-playback.ts`) — the two clients cannot share a module (React
 * Native has no `HTMLAudioElement`), but they must not diverge on the behavior.
 *
 * Deliberately a single slot rather than a set: "which clip is audible" has
 * exactly one answer.
 */

/** The only thing this needs from a player. Structural, so a test can pass a double. */
export interface PausableAudio {
  pause: () => void
}

let active: PausableAudio | null = null

/**
 * Claim the speaker for `el`, pausing whoever held it.
 *
 * Wired to the `play` EVENT rather than a click handler, so it also covers the
 * paths a click handler never sees: the keyboard, the browser's own media keys,
 * and the OS media session.
 */
export function claimExclusiveAudio(el: PausableAudio): void {
  const previous = active
  active = el
  if (previous === null || previous === el) return
  try {
    previous.pause()
  } catch {
    // An element detached between claiming and being displaced (its message was
    // edited or the pane unmounted). It is already silent — which is all
    // pausing it was for.
  }
}

/** Give the speaker up. No-op when someone else already holds it. */
export function releaseExclusiveAudio(el: PausableAudio): void {
  if (active === el) active = null
}

/** Who holds the speaker. Exists for the exclusivity test. */
export function activeExclusiveAudio(): PausableAudio | null {
  return active
}

/** Drop the registry back to empty. Tests only. */
export function __resetExclusiveAudioForTests(): void {
  active = null
}
