/**
 * @neutronai/app — the login screen's state machine, as pure functions.
 *
 * WHY THIS IS NOT IN `app/app/login.tsx`. Every branch of the login-first flow
 * (several instances → picker, none → not-provisioned, network fault →
 * retryable error, stale session → back to credentials) is a DECISION, and a
 * decision trapped inside a React component can only be checked by grepping the
 * component's source for a string. Round 1 of this branch did exactly that, and
 * the suite stayed green over a real bug: the retry control was labelled from
 * `stage.retry_discovery` but branched on `session !== null`, so "Back to sign
 * in" re-ran discovery against the previous account's token. A `toContain`
 * assertion on the source cannot catch that; `retryTargetForStage` can.
 *
 * So the rule for this file: no `react`, no `react-native`, no I/O. The screen
 * renders what these functions decide.
 */

import type { IdentityFailure } from './identity-client';

/**
 * The login screen's whole state space. A CLOSED union rather than a bag of
 * booleans, so no combination of flags can produce a stuck spinner: every
 * non-`idle` stage renders either progress WITH context, or an action the owner
 * can actually take.
 */
export type Stage =
  /** Show the sign-in options (or the identity-not-configured notice). */
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  /** Several instances — the owner picks which one to open. */
  | { kind: 'picker'; slugs: string[] }
  /** Signed in, but no instance exists yet. */
  | { kind: 'no_instance'; message: string }
  /**
   * Anything retryable. `retry_discovery` is true when the retry should re-run
   * DISCOVERY (we still hold a good session); false when the owner has to
   * present credentials again.
   */
  | { kind: 'error'; message: string; retry_discovery: boolean };

/**
 * Map a sign-in / discovery failure onto the stage that follows it.
 *
 * `retry_discovery` is the load-bearing part. It is true only for failures
 * where the session we hold is still good and re-asking `/v1/route` is the
 * right next move; for anything that invalidated the session (or never had
 * one) it is false, which sends the owner back to the sign-in options.
 */
export function nextStageForFailure(failure: IdentityFailure, message: string): Stage {
  switch (failure.kind) {
    case 'ambiguous':
      // A picker with nothing in it is a dead end. If the service said
      // "several instances" but we could not read a single slug, fall through
      // to a retryable error rather than rendering an empty list.
      return failure.slugs.length > 0
        ? { kind: 'picker', slugs: failure.slugs }
        : {
            kind: 'error',
            message:
              'You have more than one Neutron instance, but this app could not read the list. Try again, or connect to one directly below.',
            retry_discovery: true,
          };
    case 'no_instance':
      return { kind: 'no_instance', message };
    case 'oauth_cancelled':
      // The owner backed out of the provider sheet. Not an error — go straight
      // back to the sign-in options with nothing shouting at them.
      return { kind: 'idle' };
    case 'unauthorized':
    case 'identity_not_configured':
    case 'oauth_unavailable':
    case 'oauth_failed':
      // None of these leave a usable session, so retrying discovery would
      // reuse a credential the service just refused.
      return { kind: 'error', message, retry_discovery: false };
    case 'unreachable':
    case 'server':
    case 'not_owned':
      // Transient or slug-specific: re-asking `/v1/route` is the right move.
      return { kind: 'error', message, retry_discovery: true };
  }
}

/**
 * Does `nextStageForFailure` for this failure require the session to be
 * discarded? The unauthorized case is the one that matters: the service
 * rejected the token mid-flow, so holding onto it would let a later retry
 * present a credential that is known-dead.
 */
export function clearsSession(failure: IdentityFailure): boolean {
  return failure.kind === 'unauthorized';
}

/** What the retry control on a given stage should actually do. */
export type RetryTarget = 'discovery' | 'sign_in';

/**
 * Decide what the retry control does — and, because the SAME predicate drives
 * `retryLabelForStage`, guarantee the button cannot do the opposite of what it
 * says.
 *
 * BOTH conditions are required. `stage.retry_discovery` alone would re-run
 * discovery with no session at all; `session !== null` alone is the round-1 bug
 * (a stage that deliberately demands credentials again would still re-run
 * discovery, on the PREVIOUS account's token, and could sign the device into
 * that account's instance).
 */
export function retryTargetForStage(stage: Stage, hasSession: boolean): RetryTarget {
  if (stage.kind === 'no_instance') return hasSession ? 'discovery' : 'sign_in';
  if (stage.kind === 'error') return stage.retry_discovery && hasSession ? 'discovery' : 'sign_in';
  return 'sign_in';
}

/**
 * The retry control's label — derived from the same decision it performs.
 *
 * `no_instance` BRANCHES like every other stage. It used to return 'Check again'
 * unconditionally while `retryTargetForStage` branched on the session, so a
 * sessionless `no_instance` offered "Check again" and then bounced the owner to
 * sign-in — the label/action divergence this pair of functions exists to prevent.
 * Unreachable today (`clearsSession` is false for `no_instance`, so a session is
 * always present here) but it is one edit away from being reachable.
 */
export function retryLabelForStage(stage: Stage, hasSession: boolean): string {
  const target = retryTargetForStage(stage, hasSession);
  if (target === 'sign_in') return 'Back to sign in';
  // "Check again" reads better than "Try again" for the not-yet-provisioned
  // case: nothing failed, the instance simply is not there yet.
  return stage.kind === 'no_instance' ? 'Check again' : 'Try again';
}
