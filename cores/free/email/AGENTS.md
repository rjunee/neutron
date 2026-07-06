# AGENTS.md — cores/free/email-managed

This directory is the Tier 1 free Email-Managed Core
(`@neutron/email-managed-core`). It surfaces a launcher icon + eight
MCP tools (`email_list`, `email_read`, `email_thread`, `email_search`,
`email_summarize`, `email_draft_prepare`, `email_triage`, `email_send`)
wrapping Gmail v1, per the locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

**Read + draft + send.** Send was added per the 2026-06-20 daily-driver
gap-audit (P0) — earlier revisions of this Core were drafts-only, and
older copies of this file documented a "never sends" guarantee that no
longer holds. `email_send` calls `messages.send` and applies the owner
visibility labels (INBOX + IMPORTANT + UNREAD) to the sent thread, the
send-path counterpart to the 4-point draft policy.

Capability attribution (enforced by `CapabilityGuard.wrapToolHandler`,
which writes a `secret_audit_log` row per dispatch):

- READS (`email_list` / `email_read` / `email_thread` / `email_search` /
  `email_summarize` / `email_triage`) → `read:email_managed_core.messages`.
- DRAFTS (`email_draft_prepare`) → `write:email_managed_core.drafts`.
- SEND (`email_send`) → `write:email_managed_core.send` — a DISTINCT
  capability so every outbound send is independently attributable.

OAuth grant: four scopes — `gmail.readonly` (reads incl. `threads.get`),
`gmail.modify` (`threads.modify` for the visibility labels), `gmail.compose`
(`drafts.create`), `gmail.send` (`messages.send`). See README's
"OAuth scopes — the 4-scope grant" section.

It must NOT:

- Change `email_send`'s capability to reuse the drafts write capability.
  Send keeps its own `write:email_managed_core.send` so audit attribution
  stays clean.
- Drop `gmail.send` from the OAuth scope grant or remove the `email_send`
  tool — both are load-bearing for the shipped send surface.
- Re-implement OAuth consent / token exchange. The Core declares
  the `gmail_readonly` `oauth_token` secret in its manifest; the
  runtime composer drives the prompt at install time and resolves a
  live access token via the per-Core `SecretsAccessor` at request
  time.
- Make real network calls in tests. The bundled
  `buildInMemoryGmailClient` /
  `buildSeededInMemoryGmailClient` are the only backends the test
  suite uses; `buildGoogleGmailClient` is the production wrapper
  and is exercised only by integration tests outside this directory.
- Make real LLM calls in tests. The `buildStubEmailSummarizer()` is
  deterministic and reaches no network; `composeTriage` /
  `composeBriefSummary` accept a `(prompt: string) => Promise<string>`
  callable that tests stub. Production wires
  `buildSubstrateEmailLlm({substrate, model})` against the gateway's
  per-instance Substrate — exercised by integration tests in the
  gateway, not by unit tests inside this Core.
- Add a top-level `googleapis` dependency. The v1 REST surface the
  Core uses is small; a hand-rolled `fetch`-based wrapper avoids
  pulling the ~5MB transitive `googleapis` tree into Tier 1.
- Reach into other Cores' namespaces. The Core has no sidecar
  SQLite (capabilities are `read:email_managed_core.messages` +
  `write:email_managed_core.drafts`, not `.db`-suffixed) —
  persistence lives at Gmail.
- Promote launcher UI beyond manifest metadata. The actual React/RN
  icon component ships in P5.3.

Out-of-scope this sprint:

- Tier 2 Email-Private variant (Outlook / iCloud / open-weight
  alternatives, send capability) — separate
  `@neutron-paid/email-private` Core.
- Push notifications + new-mail watch — P5.6.
- Email tab UI in app — P5.4 / P5.5.
- Email ↔ Task auto-extraction (turn "please review" emails into
  tasks) — separate sprint.
- Attachment surfacing / downloads.
- Mass-management (filter rules, label management).
- PGP / encryption.
- Substrate-backed structured-row `EmailSummarizer` (the
  sentiment / ask_or_response / key_points classifier still uses
  the deterministic stub in production; a Haiku-driven replacement
  is deferred to a follow-up sprint). The prose-brief layer AND
  the triage agent already run real Haiku in production via
  `buildSubstrateEmailLlm`.

Cross-refs:

- `SPEC.md § Phases→Steps` (TODO(K10): root SPEC.md not yet in this repo; K10 recreates it) — Tier 1 Cores
  buildout (Email-Managed is #5)
- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `cores/runtime/` — install / capability gating / audit log
- `cores/free/calendar/AGENTS.md`,
  `cores/free/reminders/AGENTS.md`,
  `cores/free/tasks/AGENTS.md` — sibling Tier 1 Cores; same
  scaffolding pattern.
