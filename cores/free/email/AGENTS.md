# AGENTS.md — cores/free/email-managed

This directory is the Tier 1 free Email-Managed Core
(`@neutron/email-managed-core`). It surfaces a launcher icon + six
MCP tools (`email_list`, `email_read`, `email_search`,
`email_summarize`, `email_draft_prepare`, `email_triage`) wrapping
Gmail v1, per the locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

**Read + draft-prepare only. The Core never invokes send.**

The "never sends" guarantee is enforced at THREE layers:

- PRODUCT — no send tool, no send method on `GmailClient`, no
  `messages.send` / `drafts.send` call anywhere in the wrapper.
- OAUTH GRANT — `gmail.send` is NOT in the requested scope set
  (the Core requests `gmail.readonly` + `gmail.modify` +
  `gmail.compose`). The persisted token cannot send mail.
- AUDIT — every dispatch goes through `CapabilityGuard.
  wrapToolHandler` and writes a row to `secret_audit_log`; the
  six wrapped tools never reach send.

See README's "OAuth scopes — the 3-scope split" section for the
full rationale (incl. why these THREE scopes are the narrowest
tuple that satisfies the Tier 1 surface).

It must NOT:

- Add a `send` tool, a `send` method on `GmailClient`, or any path
  that calls `messages.send` / `drafts.send`. Send is intentionally
  Tier 2 (paid Email-Private Core). The Tier 1 free Core ships
  drafts-only forever.
- Add `gmail.send` to the OAuth scope grant. Tier 2 Email-Private
  Core requests gmail.send under a distinct secret label so audit
  attribution stays clean.
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

- `SPEC.md § Phases→Steps` — Tier 1 Cores
  buildout (Email-Managed is #5)
- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `cores/runtime/` — install / capability gating / audit log
- `cores/free/calendar/AGENTS.md`,
  `cores/free/notes/AGENTS.md`,
  `cores/free/tasks/AGENTS.md` — sibling Tier 1 Cores; same
  scaffolding pattern.
