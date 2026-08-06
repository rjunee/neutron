/**
 * @neutronai/app — the push re-registration DECISIONS, kept free of
 * `react-native` and `expo-notifications` (ISSUES #487).
 *
 * This module exists for the same reason `push-observability.ts` does: the app
 * suite cannot import `lib/push.ts`, because it pulls in `expo-notifications` /
 * `react-native`, neither of which loads under bun test. Anything that lives
 * only inside the component is therefore UNTESTABLE, and "untestable" is how a
 * self-healing mechanism quietly stops healing. So the two decisions that can
 * be wrong — when to re-run, and whether a re-run is already in flight — live
 * here, and `components/PushRegistrationSync.tsx` is the thin shell that
 * supplies the platform pieces.
 */

/** The subset of app lifecycle states this cares about. */
export type ForegroundState = 'active' | 'background' | 'inactive' | 'unknown';

/**
 * True iff this transition is the background→active edge that should trigger a
 * re-registration.
 *
 * NOT simply `next === 'active'`. iOS emits `inactive` → `active` while merely
 * dismissing a system sheet or the app switcher, and some platforms emit
 * `active` more than once in a row; treating every `active` as an arrival would
 * re-register on incidental events. Equally, this must NOT require `prev` to be
 * exactly `'background'`: iOS goes `active → inactive → background → inactive →
 * active`, so a real return from the OS Settings app (the path by which
 * notification permission gets granted) arrives with `prev === 'inactive'`. The
 * rule that satisfies both is "was not active, now is".
 */
export function cameToForeground(prev: ForegroundState, next: ForegroundState): boolean {
  return prev !== 'active' && next === 'active';
}

export interface PushSyncInput {
  /** Injected `enablePushForUser`. Documented never to throw; assumed to anyway. */
  enable: (input: { base_url: string; token: string }) => Promise<unknown>;
  base_url: string;
  token: string;
  /**
   * Caller-owned guard cell (a React ref in the component). Shared across
   * every call for one mounted component so a foreground burst cannot open two
   * concurrent registrations.
   */
  in_flight: { current: boolean };
}

/**
 * Run one registration attempt. Resolves when it settles; NEVER rejects — a
 * push failure must not propagate into the tree that renders the app, and
 * every outcome is already recorded by `enablePushForUser` through
 * `push-observability`.
 *
 * Returns whether the attempt actually ran, so a caller (and a test) can
 * distinguish "registered" from "skipped because one was already in flight".
 */
export async function syncPushRegistration(input: PushSyncInput): Promise<boolean> {
  if (input.in_flight.current) return false;
  input.in_flight.current = true;
  try {
    await input.enable({ base_url: input.base_url, token: input.token });
  } catch {
    // Contract says unreachable. Swallowed rather than trusted.
  } finally {
    // `finally`, not the end of `try`: a throwing `enable` must still clear the
    // cell, or one transient failure would wedge registration for the whole
    // lifetime of the mount — a self-healing mechanism that stops healing after
    // its first bad day is worse than none, because nothing looks broken.
    input.in_flight.current = false;
  }
  return true;
}
