# AGENTS.md — cores/free/google-workspace

This directory is the Tier 1 free Google Workspace Core
(`@neutronai/google-workspace-core`). It surfaces nine MCP tools across
three Google APIs:

- Drive v3 — `drive_list`, `drive_read`, `drive_upload`
- Sheets v4 — `sheets_read`, `sheets_append`, `sheets_update`
- Docs v1 — `docs_read`, `docs_create`, `docs_update`

It closes the gap-audit external-tool floor (P0-6,
`docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`),
where Drive/Sheets/Docs were MISSING entirely.

It must NOT:

- Re-implement OAuth consent / token exchange. The Core declares the
  `google_workspace` `oauth_token` secret in its manifest; the runtime
  composer drives the prompt at install time and resolves a live
  access token via the per-Core `SecretsAccessor` at request time —
  the SAME plumbing Calendar (`google_calendar`) + Email
  (`gmail_compose`) use. This is per-Core OAuth, NOT a global token.
- Make real network calls in tests. `buildInMemoryGoogleWorkspaceClient`
  backs `__tests__/tools.test.ts`; the production REST wrappers accept
  a `fetchImpl` override so `__tests__/backend.test.ts` asserts the
  exact HTTP method/path/payload each op sends.
- Add a top-level `googleapis` dependency. The REST surface is small;
  a hand-rolled `fetch`-based wrapper avoids the ~5MB transitive tree.
- Reach into other Cores' namespaces. The Core has no sidecar SQLite
  (capabilities are `read:/write:google_workspace_core.{drive,sheets,docs}`,
  not `.db`-suffixed) — persistence lives at Google.

Out-of-scope this sprint:

- Delete / trash files, ACL/sharing changes, folder moves.
- Resumable / binary Drive uploads (v1 is text multipart only).
- The full Docs `batchUpdate` request grammar (`docs_update` is
  insertText-only: append, or insert at a 1-based offset).
- Sheets formatting / chart / pivot operations (values only).
- Admin / connectors UI (separate task).

Cross-refs:

- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `cores/runtime/` — install / capability gating / audit log
- `cores/free/calendar/AGENTS.md`, `cores/free/email/AGENTS.md` —
  sibling Google-backed Tier 1 Cores; same scaffolding + OAuth pattern.
