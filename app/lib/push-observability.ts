/**
 * @neutronai/app — make the push-registration outcome OBSERVABLE (ISSUES #487).
 *
 * `device_push_tokens` was found holding zero rows on a live instance, which
 * meant every proactive surface — rituals, the morning brief, nudges, the
 * lapsed-credential notice — reached the app and nothing reached the phone.
 * Nobody noticed for weeks, and the reason nobody noticed is structural:
 *
 *   - `lib/push.ts` is documented as never throwing. It models every failure
 *     as a typed result, and the login screen turned that result into a
 *     `console.warn` — which exists only for a developer holding a USB cable.
 *   - the gateway logged nothing either (fixed in the same change:
 *     `gateway/http/app-devices-surface.ts`).
 *
 * So "the app never asked for permission", "the owner denied it", "the EAS
 * projectId is missing from this build" and "the gateway rejected the bearer"
 * all produced identical evidence on the owner's device: none.
 *
 * This module turns each of those into a recorded diagnostic, using the
 * mechanism the app ALREADY has for exactly this problem — the diagnostics
 * ring buffer + persisted report queue (`lib/diagnostics.ts`), which delivers
 * to the OWNER'S OWN gateway (no Sentry, no third party). Nothing new is
 * invented here; a failure simply stops being discarded.
 *
 * DELIVERY, concretely. A recorded event alone sits in the ring buffer until
 * something captures a report, so an ACTIONABLE failure also captures one,
 * which persists it to the queue. `components/DiagnosticsSync.tsx` flushes the
 * queue on the first authenticated render of a launch, and `app/login.tsx`
 * calls `enablePushForUser` BEFORE `setUser` (`app/login.tsx:219-220`) — so the
 * report queued by a failed enable is delivered by the very same launch that
 * produced it.
 *
 * WHAT COUNTS AS ACTIONABLE. `unsupported_platform` is the web build, where
 * native push does not exist; capturing a report every time the owner opens the
 * app in a browser would be noise that trains the reader to ignore the channel.
 * It is recorded, not escalated. Every other reason is a real, fixable reason
 * the owner's phone is silent, including a denied permission — that is the most
 * likely cause of an empty table and the owner cannot fix what they cannot see.
 *
 * NEVER RECORD THE TOKEN. The Expo push token is a credential: whoever holds it
 * can push to the owner's device. Success records the PLATFORM and the token's
 * LENGTH, never its value. (`lib/diagnostic-report.ts` also scrubs known
 * secrets on the way out, but that is a backstop keyed on the bearer, not a
 * licence to hand it the token.)
 *
 * PURE-ish + INJECTABLE. The two side effects arrive as `deps` so this file is
 * testable under `bun test` without React Native — `lib/push.ts` itself imports
 * `expo-notifications` and cannot be loaded there at all, which is why the
 * mapping lives in its own module rather than inline at the call site.
 */

import type { ReportReason } from './diagnostic-report';
import { captureReport, recordDiagnosticEvent, type RecordInput } from './diagnostics';

/**
 * The reason a report is filed for a push-registration failure. Deliberately
 * a new member of the EXISTING `ReportReason` union rather than a parallel
 * reporting path — one queue, one flush, one place to read.
 */
export const PUSH_REPORT_REASON: ReportReason = 'push_registration_failed';

/** Diagnostic `kind` every line from this module carries, for grepping. */
export const PUSH_DIAGNOSTIC_KIND = 'push';

/**
 * Structural mirror of `lib/push.ts`'s `PushEnableResult & { registered?: … }`.
 *
 * Declared here rather than imported so this module has NO dependency on
 * `push.ts` — that module pulls in `expo-notifications` at import time, and an
 * import (even a type-only one) would be an edge in the wrong direction
 * between a leaf and the platform-bound caller. `push.ts` passes its result
 * straight in; TypeScript checks the shapes match at that call site.
 */
export type PushEnableOutcome =
  | { ok: true; device_token: string; platform: string; registered?: boolean }
  | { ok: false; skipped: true; reason: string; detail?: string };

/** The two side effects, injected so the mapping is testable in isolation. */
export interface PushObservabilityDeps {
  record: (input: RecordInput) => void;
  capture: (reason: ReportReason) => Promise<unknown>;
}

const defaultDeps: PushObservabilityDeps = {
  record: recordDiagnosticEvent,
  capture: captureReport,
};

/**
 * Reasons that are a fact about the platform rather than a fault to chase.
 * Recorded, never escalated to a queued report.
 */
const BENIGN_REASONS: ReadonlySet<string> = new Set(['unsupported_platform']);

/** True iff this outcome should also file a report for delivery. */
export function isActionableFailure(outcome: PushEnableOutcome): boolean {
  return !outcome.ok && !BENIGN_REASONS.has(outcome.reason);
}

/**
 * Record the outcome of a push-registration attempt, and file a report when the
 * failure is one the owner could act on.
 *
 * Never throws: this runs on the login path, and observability that can break
 * sign-in is worse than no observability. A failing recorder is itself
 * swallowed — the alternative is wedging the very flow we are instrumenting.
 */
export async function reportPushEnableOutcome(
  outcome: PushEnableOutcome,
  deps: PushObservabilityDeps = defaultDeps,
): Promise<void> {
  try {
    deps.record(describePushEnableOutcome(outcome));
    if (isActionableFailure(outcome)) {
      await deps.capture(PUSH_REPORT_REASON);
    }
  } catch {
    // Deliberately silent. See the doc comment above.
  }
}

/**
 * The pure half: outcome → diagnostic event. Exported so a test can assert the
 * exact recorded shape (and the ABSENCE of the token) without stubbing the
 * whole diagnostics runtime.
 */
export function describePushEnableOutcome(outcome: PushEnableOutcome): RecordInput {
  if (outcome.ok) {
    return {
      kind: PUSH_DIAGNOSTIC_KIND,
      level: 'info',
      message: 'push registration succeeded',
      context: {
        platform: outcome.platform,
        // LENGTH, not the token. Enough to tell an empty/garbage token from a
        // real `ExponentPushToken[…]` when a registration mysteriously does
        // not stick, without writing a credential into a report.
        token_chars: outcome.device_token.length,
        registered: outcome.registered === true,
      },
    };
  }
  const context: Record<string, unknown> = { reason: outcome.reason };
  if (outcome.detail !== undefined) context['detail'] = outcome.detail;
  // A benign skip is information; anything else is the phone going silent.
  const benign = BENIGN_REASONS.has(outcome.reason);
  return {
    kind: PUSH_DIAGNOSTIC_KIND,
    level: benign ? 'info' : 'warn',
    message: `push registration ${benign ? 'skipped' : 'failed'}: ${outcome.reason}`,
    context,
  };
}
