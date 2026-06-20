# @neutron/email-managed-core

Tier 1 free Email-Managed Core for Neutron. Wraps Gmail v1 and
surfaces five MCP tools:

- `email_list` — list message metadata for a label, newest-first
  (the natural inbox semantic)
- `email_read` — fetch the full body + headers of a single message
- `email_search` — run a Gmail-style query
  (`from:alice@x.com is:unread`)
- `email_summarize` — structured summary (from, subject,
  key_points, sentiment, ask_or_response). Calls an LLM
  (`EmailSummarizer`) — Haiku 4.5 in production, deterministic
  stub in tests.
- `email_draft_prepare` — create a Gmail DRAFT. **Never sends.**
  Drafts land in the user's Drafts label for review.

Bundled into the public OSS repo at `cores/free/email-managed/` per
the locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

## Send is NOT invoked — Tier 1 product-level guarantee

The Tier 1 free Email-Managed Core is **read + draft-prepare only**.

- The tool surface declares NO `email_send` / `email_reply` /
  `email_forward` tool. Regression-guarded in
  `__tests__/manifest.test.ts`.
- The `GmailClient` interface declares NO `send` method anywhere.
  The in-memory fake AND the production wrapper both omit it.
- The production wrapper hand-rolled against Gmail v1 REST never
  reaches the `messages.send` / `drafts.send` endpoints.

A Tier 2 paid Email-Private Core will ship send capability with a
distinct `write:email_private_core.send` capability and a distinct
secret label (`gmail_send` or similar), so audit attribution stays
clean.

When a drafted message is ready, the user opens Gmail and clicks
Send themselves. This is the deliberate Tier 1 guarantee.

### OAuth scopes — the 3-scope split, and why `gmail.send` is excluded

The Core requests **three** Google OAuth scopes — every one is
load-bearing for a specific production code path:

- **`gmail.readonly`** — `messages.list` / `messages.get` /
  metadata reads. The triage agent, the summarizer, `email_list`,
  `email_read`, and `email_search` all need this scope. Without it
  every read path returns 403 against real Gmail.
- **`gmail.modify`** — `threads.modify`. The mandatory owner 4-point
  draft policy (every drafted thread MUST land with INBOX +
  IMPORTANT + UNREAD on it before `createDraft` returns success)
  needs this scope. Without it the post-`drafts.create`
  threads.modify call 403s and the draft sits invisibly in the
  Drafts label.
- **`gmail.compose`** — `drafts.create`. Without it the Core can't
  prepare drafts at all.

`gmail.send` is **deliberately and permanently excluded**. The Core
has no send tool, no send method anywhere on the `GmailClient`
surface, and the OAuth grant doesn't authorise sending mail either.
The Tier 2 paid Email-Private Core will request `gmail.send`
separately, store its token under a distinct secret label, and own
a distinct `write:email_private_core.send` capability so audit
attribution stays clean across the two Cores.

This is the deliberate owner rule: the user clicks Send themselves
in Gmail when a drafted message is ready. The Tier 1 "no auto-send"
guarantee is enforced at THREE layers:

1. **Product surface.** No send tool. No send method on
   `GmailClient`. Regression-guarded in `__tests__/manifest.test.ts`.
2. **OAuth grant.** `gmail.send` is not in the requested scope set.
   Even a misuse of the persisted token OUTSIDE this Core can't
   send mail with these credentials.
3. **Audit log.** Every dispatch goes through
   `CapabilityGuard.wrapToolHandler` and writes a row to
   `secret_audit_log`; the six wrapped tools never touch send.

Previous versions of this README documented `gmail.compose` as the
sole scope, with a "honest trust boundary" caveat that the persisted
token was technically powerful enough to send. That caveat is gone:
the OAuth grant no longer includes `gmail.send`, so the token is
NOT powerful enough to send. The 3-scope split closes the gap.

### Why these three scopes, and not (`gmail.metadata` + `gmail.compose`)

Gmail does not ship a "drafts only" scope that allows
`threads.modify` without a broader grant. The narrowest tuple that
satisfies the Tier 1 surface (read + label-management for drafts +
draft creation, NO send) is `(gmail.readonly, gmail.modify,
gmail.compose)`. If Google ships a narrower set in the future, the
Core will migrate to it.

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
5. Registers the five MCP tools, each capability-guarded by
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
  — "most recent at the top"). Distinct from the Calendar Core's
  chronological-ascending ordering (meetings face forward; inboxes
  face backward).
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
- **No batch send / no send at all.** Tier 1 guarantee.

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
