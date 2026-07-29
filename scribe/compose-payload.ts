/**
 * @neutronai/scribe — Cores-source payload composition (phase 2).
 *
 * The extraction prompt (`extract.ts:SCRIBE_EXTRACTION_PROMPT`) is payload-
 * agnostic: it pulls entities + relations out of arbitrary text. Phase 2 feeds
 * it calendar events + email messages by flattening an already-fetched Core row
 * into the SAME plain-text shape Nova's scribe pollers used — the *composition*
 * is lifted from `scribe-calendar-poll.sh` / `scribe-email-poll.sh`, but NOT the
 * pollers themselves (the Managed Cores' connectors + schedulers are the only
 * source of "when"; see `gateway/cores/calendar-wiring.ts` +
 * `gateway/cores/email-managed-wiring.ts`).
 *
 * These helpers are intentionally duck-typed (structural input interfaces) so
 * `scribe/` carries NO dependency on `@neutronai/calendar-core` /
 * `@neutronai/email-managed-core` — a `CalendarEventRow` / `GmailMessageMeta`
 * structurally satisfies the input shape at the call site.
 */

/** Structural subset of `CalendarEventRow` the calendar payload reads. */
export interface CalendarPayloadSource {
  title: string
  attendees?: string[]
  description?: string
}

/**
 * Flatten a calendar event into extraction text. Mirrors Nova's
 * `scribe-calendar-poll.sh:102-111` exactly: `title` (newlines flattened,
 * capped 200) / `attendees: <comma-joined emails>` (capped 1000) / blank line /
 * `description` (capped 2000). The caps bound a single extract's token cost.
 */
export function composeCalendarPayload(event: CalendarPayloadSource): string {
  const title = (event.title ?? '').replace(/\n/g, ' ').slice(0, 200)
  const attendees = (event.attendees ?? []).join(', ').slice(0, 1000)
  const desc = (event.description ?? '').slice(0, 2000)
  return `${title}\nattendees: ${attendees}\n\n${desc}`
}

/** Structural subset of `GmailMessageMeta` / `GmailMessageFull` the email payload reads. */
export interface EmailPayloadSource {
  subject: string
  /** From header value (e.g. `"Alice" <alice@x.com>`). */
  from: string
  snippet: string
  /** Full body, when available (`GmailMessageFull`). Absent on list metadata. */
  body_text?: string
}

/**
 * Flatten an email message into extraction text. Mirrors Nova's
 * `scribe-email-poll.sh:155-167` MINUS the D1 `category(conf)` field — Neutron's
 * Email Managed Core has no email-system classifier, so the payload is
 * `subject | from` (capped 200 / raw) / `snippet` (capped 400) / `body_text`
 * (capped 2000; empty when only list metadata was fetched — no second fetch).
 */
export function composeEmailPayload(msg: EmailPayloadSource): string {
  const subj = (msg.subject ?? '').slice(0, 200)
  const frm = msg.from ?? ''
  const snip = (msg.snippet ?? '').slice(0, 400)
  const body = (msg.body_text ?? '').slice(0, 2000)
  return `${subj} | ${frm}\n${snip}\n${body}`
}
