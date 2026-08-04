/**
 * @neutronai/app — diagnostic report assembly (pure).
 *
 * Turns a window of recorded events plus a little device context into the exact
 * payload the gateway persists. This is the LAST place a value can be changed
 * before it leaves the process, so it is also the place the redaction invariant
 * is enforced and tested: `buildClientReport` scrubs every event again, with
 * the caller's live credentials as exact needles.
 *
 * WHAT IS DELIBERATELY ABSENT FROM A REPORT
 * -----------------------------------------
 *   - the bearer, in any form;
 *   - request/response headers, which are where a bearer usually hides;
 *   - the app's auth-service URL and any other configuration. The one exception
 *     is `origin`, the gateway the report was captured against, which exists
 *     solely so a queued report can never be delivered to a DIFFERENT instance
 *     after a server change (see the field's own note). The gateway discards it.
 *   - anything about the user beyond `signed_in`;
 *   - the user's identity beyond `signed_in: boolean`. The gateway stamps the
 *     authenticated `user_id` itself from the bearer, which is both more
 *     trustworthy and not the device's to assert.
 *
 * PURE — no React, no Expo, no clock, no randomness of its own; `now` and
 * `report_id` are supplied. Unit-tested directly under `bun test`.
 */

import type { DiagnosticEvent } from './diagnostic-buffer';
import {
  MAX_STRING_CHARS,
  redactContext,
  redactStack,
  redactString,
  truncate,
} from './diagnostic-redact';

/**
 * Why a report was created.
 *
 * `push_registration_failed` (ISSUES #487) is not an error the app CAUGHT — it
 * is an outcome the app was told about and used to discard. Push registration
 * cannot throw by design, so a phone that silently stops receiving anything
 * produces no js_error, no rejection and no crash; without its own reason it
 * would produce no report either. See `lib/push-observability.ts`.
 */
export type ReportReason =
  | 'js_error'
  | 'unhandled_rejection'
  | 'render_crash'
  | 'manual'
  | 'push_registration_failed';

/** Device / build context. Everything here is non-identifying build metadata. */
export interface ReportAppContext {
  version: string;
  build: string | null;
  platform: string;
  os_version: string | null;
}

/** The wire + storage shape. Mirrored by
 *  `gateway/diagnostics/client-report-redaction.ts:StoredClientReport`. */
export interface ClientReport {
  schema: number;
  report_id: string;
  created_at: number;
  /**
   * The gateway this report was GENERATED against — the resolved
   * `gateway_base_url` at capture time, or `''` when the app was not yet
   * configured (a crash inside the first-run setup gate).
   *
   * The queue survives a server change on purpose (a report is evidence about
   * the app, not the session), which means without this field a report captured
   * against one instance would be delivered to whichever instance the owner
   * pointed at next — disclosing one server's diagnostics to another. The flush
   * filters on it. `''` is deliverable anywhere, because a report captured
   * before any server existed belongs to the first server the owner configures,
   * by definition. (Codex cross-model review r2 P1.)
   */
  origin: string;
  reason: ReportReason;
  app: ReportAppContext;
  session: { signed_in: boolean };
  events: DiagnosticEvent[];
  /**
   * Set when the event window was TRIMMED to fit the gateway's request ceiling
   * (`lib/diagnostic-queue.ts:fitReport`). Present so a reader knows they are
   * looking at part of a window rather than all of it — a silently shortened
   * report is how a diagnosis goes wrong.
   */
  truncated?: boolean;
}

export const REPORT_SCHEMA_VERSION = 1;

export interface BuildClientReportInput {
  report_id: string;
  created_at: number;
  /** Resolved gateway base URL at capture time; `''` when unconfigured. */
  origin: string;
  reason: ReportReason;
  app: ReportAppContext;
  signed_in: boolean;
  events: readonly DiagnosticEvent[];
  /**
   * Exact credential values to remove from every string in the report — in
   * practice the live session bearer. Passing them is what makes the redaction
   * guarantee unconditional rather than pattern-dependent.
   */
  secrets?: readonly string[];
}

/**
 * Assemble a report, scrubbing every event on the way in.
 *
 * The scrub is applied HERE (and not only at record time) on purpose: it is the
 * single choke point every report passes through, whichever path created it —
 * global handler, error boundary, or the manual Settings action — so one test
 * on this function covers all of them. Neutralise the scrub and
 * `app/__tests__/diagnostic-redaction-invariant.test.ts` goes red.
 */
export function buildClientReport(input: BuildClientReportInput): ClientReport {
  const secrets = input.secrets ?? [];
  return {
    schema: REPORT_SCHEMA_VERSION,
    report_id: input.report_id,
    created_at: input.created_at,
    // NOT run through the redactor: this is our own normalised base URL, never
    // a credential, and mangling it would break the delivery filter.
    origin: truncate(input.origin, 512),
    reason: input.reason,
    app: {
      version: truncate(input.app.version, 64),
      build: input.app.build === null ? null : truncate(input.app.build, 64),
      platform: truncate(input.app.platform, 32),
      os_version: input.app.os_version === null ? null : truncate(input.app.os_version, 64),
    },
    session: { signed_in: input.signed_in },
    events: input.events.map((event) => redactEvent(event, secrets)),
  };
}

/** Scrub one event. Exported so the recorder can apply it at capture time too —
 *  a token should not sit in the device's memory either, not just avoid the
 *  wire. */
export function redactEvent(
  event: DiagnosticEvent,
  secrets: readonly string[],
): DiagnosticEvent {
  const out: DiagnosticEvent = {
    at: event.at,
    level: event.level,
    kind: truncate(event.kind, 64),
    message: truncate(redactString(event.message, secrets), MAX_STRING_CHARS),
  };
  if (event.stack !== undefined && event.stack.length > 0) {
    out.stack = redactStack(event.stack, secrets);
  }
  if (event.context !== undefined) {
    out.context = redactContext(event.context, secrets);
  }
  return out;
}

/**
 * Normalise anything a JS runtime can throw — `Error`, a string, `undefined`,
 * a rejected promise's arbitrary reason — into a message + optional stack.
 * A crash reporter that only understands `Error` misses exactly the weird
 * cases you most need to see.
 */
export function describeThrown(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    const out: { message: string; stack?: string } = {
      message: `${value.name}: ${value.message}`,
    };
    if (typeof value.stack === 'string' && value.stack.length > 0) out.stack = value.stack;
    return out;
  }
  if (typeof value === 'string') return { message: value };
  if (value === null) return { message: 'null' };
  if (value === undefined) return { message: 'undefined' };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}
