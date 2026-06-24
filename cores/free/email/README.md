# @neutron/email-managed-core

Tier 1 free Email-Managed Core for Neutron. Wraps Gmail v1 and
surfaces **eight** MCP tools:

- `email_list` — list message metadata for a label, newest-first
  (the natural inbox semantic)
- `email_read` — fetch the full body + headers of a single message
- `email_thread` — fetch a whole conversation by thread id
  (`users.threads.get`): every message in the thread plus derived
  thread metadata (subject, participants, message_count,
  last_message_date, label union). Messages come back **oldest-first**
  — the natural conversation reading order, the inverse of the
  newest-first list/search ordering. One round-trip, no N+1.
- `email_search` — run a Gmail-style query
  (`from:alice@x.com is:unread`)
- `email_summarize` — structured summary (from, subject,
  key_points, sentiment, ask_or_response). Calls an LLM
  (`EmailSummarizer`) — Haiku 4.5 in production, deterministic
  stub in tests.
- `email_draft_prepare` — create a Gmail DRAFT. Drafts land in the
  user's Drafts label with the owner 4-point labels (INBOX +
  IMPORTANT + UNREAD) applied atomically.
- `email_triage` — Haiku-fast triage agent over the recent inbox,
  returning a top-5 ranked list with one-line reasons.
- `email_send` — send mail via `messages.send` (see below).

Bundled into the public OSS repo at `cores/free/email/` per
the locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

## Send IS supported (gap-audit P0 reversal)

> **History.** Send was originally carved OUT of this Tier 1 Core
> (drafts-only, with send reserved for a Tier 2 paid Core). The
> gap-audit
> (`docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`,
> P0) **reversed that product decision** — Gmail-send is a daily-driver
> need — so `gmail.send` + the `email_send` tool now ship here. Earlier
> revisions of this README documented a "no-send Tier 1 guarantee";
> that guarantee no longer holds and this section supersedes it.

`email_send` calls `messages.send`, then applies the owner visibility
labels (INBOX + IMPORTANT + UNREAD, + `Neutron/<project_id>` when
supplied) to the sent thread — the send-path counterpart to the
4-point draft policy. Send gets its **own** distinct capability
(`write:email_managed_core.send`), separate from the drafts write
capability, so every outbound send is independently attributable in
the audit log. Header values containing CR/LF/NUL are rejected at the
shared `buildRawMessage` MIME layer (header-injection guard).

The 4-point DRAFT rule (DRAFT + INBOX + IMPORTANT + UNREAD) is
unchanged: drafts still land in the Drafts label for the user to
review and send manually whenever they prefer that flow.

### OAuth scopes — the 4-scope grant

The Core requests **four** Google OAuth scopes — every one is
load-bearing for a specific production code path:

- **`gmail.readonly`** — `messages.list` / `messages.get` /
  `threads.get` / metadata reads. The triage agent, the summarizer,
  `email_list`, `email_read`, `email_thread`, and `email_search` all
  need this scope. Without it every read path returns 403 against real
  Gmail.
- **`gmail.modify`** — `threads.modify`. The mandatory owner
  visibility-label policy (every drafted/sent thread MUST land with
  INBOX + IMPORTANT + UNREAD on it) needs this scope.
- **`gmail.compose`** — `drafts.create`. Without it the Core can't
  prepare drafts.
- **`gmail.send`** — `messages.send`. Backs the `email_send` tool.

Every dispatch goes through `CapabilityGuard.wrapToolHandler` and
writes a row to `secret_audit_log`, so reads, drafts, and sends are
each attributable to their declared capability.

## Install

The runtime composer installs this Core automatically when the
bundled-Core registry boots from a root that includes
`cores/free/*` (multi-root mechanic shipped in PR #139). On install
the lifecycle:

1. Validates the manifest (Sprint 24 `parseManifest`).
2. Prompts for the Gmail OAuth access token (manifest declares
   `secrets[0] = { kind: 'oauth_token', label: 'gmail_compose',
   scope: 'https://www.googleapis.com/auth/gmail.compose', required:
   true }`). Missing-token abort surfaces as
   `CoreInstallError(code: 'manifest_invalid')`.
3. Persists the access token (and optional expiry) via the audited
   platform `SecretsStore`.
4. Allocates a `tables`-layout namespace (the Core has no sidecar —
   persistence delegates to Gmail; no `.db`-suffixed capability).
5. Registers the eight MCP tools, each capability-guarded by
   Sprint 31's `CapabilityGuard.wrapToolHandler`.

The launcher icon surface (`ui_components[0]`) is manifest metadata
only at v1; the actual launcher tab lands in P5.3.

## OAuth notes (v1 substrate)

The Core does NOT drive a Google consent screen. It declares the
secret in its manifest and trusts the runtime composer to
materialize a live access token before each request. The production
wrapper (`buildGoogleGmailClient`) takes a lazy
`accessToken: () => Promise<string | null>` accessor so the composer
can refresh out-of-band. Missing token surfaces as
`OAuthMissingError` — the composer interprets this as "re-prompt for
OAuth consent".

Full Google consent + refresh-token plumbing is a follow-up sprint
(blocked by the substrate-side Google OAuth flow the owner flagged as
non-trivial in earlier briefs). For early dogfood, the operator can
paste an access token through the `SecretsPrompter`'s
`promptOauthToken` implementation.

### Why three scopes, not one

See the "OAuth scopes — the 3-scope split" section above for the
full rationale. Short version: the Tier 1 surface needs reads
(`gmail.readonly`) + label management on drafted threads
(`gmail.modify`) + draft creation (`gmail.compose`). `gmail.send`
is intentionally excluded so the persisted token can't send mail
under any circumstances. Tier 2 Email-Private Core will request
`gmail.send` separately under a distinct secret label.

## LLM summarization + triage

The Core ships **two** Haiku 4.5 driven agents (production:
`claude-haiku-4-5-20251001` via `@neutron/runtime`'s `FAST_MODEL`):

- **Prose-brief summarizer** (`src/summarizer.ts`). `composeBriefSummary`
  takes the structured row from the deterministic `EmailSummarizer`
  + the raw message body + a `(prompt: string) => Promise<string>`
  callable, returns a 2-3 sentence prose brief. Used by the
  `email_summarize` MCP tool when `as_brief:true` and by the
  `/email summarize` chat command.
- **Inbox triage agent** (`src/triage.ts`). `composeTriage` takes
  the most-recent inbox metadata + the same LLM callable, returns
  a top-5 ranked list with one-line reasons. Used by the
  `email_triage` MCP tool, the `/email triage` chat command, and
  the daily scheduler (`src/triage-scheduler.ts`).

Both agents have deterministic fallbacks: LLM call throws →
`outcome:'llm_error'` + a heuristic ranking / bulletised
key_points. A Haiku outage never silently drops a triage or
returns an empty brief.

The production substrate wiring lives in `src/substrate-llm.ts`:

```ts
import { buildSubstrateEmailLlm } from '@neutron/email-managed-core'

const emailHaikuLlm = buildSubstrateEmailLlm({
  substrate,            // the gateway's per-instance Substrate
  model: FAST_MODEL,    // 'claude-haiku-4-5-20251001'
})
```

`buildSubstrateEmailLlm` returns the `(prompt: string) =>
Promise<string>` callable both `composeBriefSummary` and
`composeTriage` consume. Under the hood it dispatches
`substrate.start({prompt, tools: [], model_preference: [FAST_MODEL]})`
and drains the SessionHandle events stream. Mirrors the pattern
`onboarding/history-import/substrate-callers.ts` uses for the
Pass-1 / Pass-2 import callers.

Tests inject a stub `(prompt: string) => Promise.resolve('{...}')`
instead — the suite never reaches an LLM. Both
`__tests__/triage.test.ts` and `__tests__/summarizer.test.ts`
exercise the happy LLM-success path AND the deterministic
fallback path.

The reference `EmailSummarizer` interface (used by the structured-
row pre-pass before the prose-brief composer runs):

- `buildStubEmailSummarizer()` — deterministic heuristic
  classifier. Used by every test in `__tests__/` AND in production
  (the structured row's sentiment + ask/response classification is
  good enough at v1; the Haiku brief on top adds the prose layer).
- `buildSubstrateEmailSummarizer({substrate})` (DEFERRED) — a
  future sprint replaces the stub with a Haiku-driven structured-
  JSON classifier. v1 ships the stub at the structured layer; the
  prose-brief Haiku call is the real production LLM dispatch.

## Behaviour notes

- **Ordering.** `email_list` and `email_search` return messages
  newest-first by Gmail `internalDate` (the natural inbox semantic
  — "most recent at the top"). `email_thread` is the **inverse** —
  messages come back oldest-first, the natural top-to-bottom
  conversation reading order. Both are distinct from the Calendar
  Core's chronological-ascending ordering (meetings face forward;
  inboxes face backward).
- **Thread reads are one round-trip.** Unlike list/search (N+1 —
  one `messages.get` per ref), `email_thread` uses
  `users.threads.get?format=full`, which inlines every message's
  full payload in a single response.
- **Default label.** `'INBOX'` — Gmail's main-inbox id. Pass a
  custom label id (e.g. `'IMPORTANT'`, `'UNREAD'`, a user label
  like `'Label_42'`) to scope the query.
- **N+1 list cost.** Gmail's `messages.list` returns only
  `(id, threadId)` refs — no headers, no snippet. Filling the
  Core's `GmailMessageMeta` shape requires a `messages.get` per
  ref. For Tier 1 we accept the cost (lists are typically < 25
  rows). A batch endpoint lands when the surface needs it.
- **No attachments.** Bodies are extracted; attachments are
  ignored. Attachment surfacing is a follow-up sprint.
- **No batch send.** `email_send` sends one message per call; there
  is no bulk-send endpoint.

## Testing

```
bun test cores/free/email-managed
```

Tests use the bundled in-memory `GmailClient` + the deterministic
stub `EmailSummarizer`, so the suite never reaches Gmail or an LLM.
The production wrapper (`buildGoogleGmailClient`) is only exercised
by integration tests outside this directory.

## Not wired this sprint

- **Production-side bundled-registry wiring.**
  `buildBundledRegistry` has no production call site yet — adding
  `cores/free/email-managed` to a default Open bundled-roots array
  would have nothing to wire into. Wiring lands in the follow-up
  sprint that boots the registry from `gateway/composition.ts`.
- **Substrate-backed structured-row `EmailSummarizer`.** The
  structured pre-pass (sentiment / ask_or_response / key_points)
  currently uses the deterministic heuristic stub in production.
  A Haiku-driven classifier replacement is deferred to a follow-
  up sprint. The prose-brief layer + the triage agent ALREADY
  run real Haiku in production via `buildSubstrateEmailLlm`.
- **Full OAuth consent / refresh-token flow.** The Core defers to
  the runtime composer for token materialisation.
- **Attachment surfacing.**
- **Mass-management** (filter rules, label management).
- **Non-Gmail providers** (Tier 2 paid `@neutron-paid/email-private`).
- **Send.** Forever, in this Core. Tier 2 Email-Private only.
- **Encryption.** Tier 2 only.
- **Push for new-mail notifications** (P5.6 wires this when the
  app shell ships).
