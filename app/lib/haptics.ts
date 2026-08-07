/**
 * @neutronai/app — the app's haptic vocabulary.
 *
 * Owner request: *"a very subtle haptic vibration when tapping to switch projects,
 * and also when doing a voice note when the recording starts and when it stops."*
 *
 * WHY A WRAPPER RATHER THAN CALLING `expo-haptics` AT EACH SITE.
 *
 * 1. **"Subtle" is a decision, not a per-call guess.** Three call sites reaching
 *    for `Haptics` independently is how one of them ends up on `Heavy` and the
 *    app starts feeling like a slot machine. The mapping from EVENT to feedback
 *    lives here, once, named for the event rather than the intensity.
 *
 * 2. **Haptics must never be able to break the thing they annotate.** They are
 *    unavailable on a simulator, on web, on a device with the setting off, and on
 *    hardware with no actuator — and `expo-haptics` rejects rather than no-ops in
 *    some of those. A rejected promise on the recording-start path would surface as
 *    a failed voice note, which is a far worse bug than a missing buzz. So every
 *    call here is fire-and-forget with the rejection swallowed: a haptic is the
 *    LEAST important thing happening in any turn it appears in.
 *
 * The two feedback kinds are chosen, not interchangeable:
 *
 *   - `selectionAsync` for switching projects. It is the platform's
 *     "selection changed" tick — the lightest thing either OS offers, and
 *     semantically exactly what a rail tap is. `impactAsync` here would be too
 *     much for something the owner does dozens of times an hour.
 *   - `impactAsync(Light)` for recording start/stop. A recording boundary is a
 *     STATE CHANGE the owner needs to feel without looking, since the whole point
 *     of a voice note is that his eyes are elsewhere. A selection tick is too
 *     faint to confirm "the mic is live"; Light is the smallest impact that reads
 *     as an event rather than a twitch.
 */

import * as Haptics from 'expo-haptics';

/**
 * Run a haptic without ever letting it affect the caller.
 *
 * Deliberately not `async` and deliberately returns void: an `await` here would
 * put a hardware call on the critical path of a state transition, and a caller
 * that forgot the `await` would produce an unhandled rejection on exactly the
 * devices where haptics are unavailable.
 */
function fire(run: () => Promise<void>): void {
  try {
    void run().catch(() => undefined);
  } catch {
    // A synchronous throw (module unavailable on this platform) is as ignorable
    // as a rejection. Nothing about this feature is worth an error path.
  }
}

/** Switching projects in the rail. The lightest tick either platform offers. */
export function hapticProjectSwitch(): void {
  fire(() => Haptics.selectionAsync());
}

/** A voice recording just went live — the mic is hot. */
export function hapticRecordingStarted(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A voice recording just stopped — the clip is held for review. */
export function hapticRecordingStopped(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}
