## 2026-10-04 — Explicit project grants from configured Codex accounts

The web project connection panel and phone project chat settings previously offered
only an independent-account auth.json paste. The new metadata-only account list
requires an owner to select an account and press Connect before granting project
access (`landing/chat-react/SettingsTab.tsx:1148`,
`app/components/ProjectChatSettings.tsx:119`). The UI explains that account-wide
reviewer seats are not project owner grants. The existing independent-account
paste stays available; a duplicate-paste refusal refreshes account metadata so
the owner can follow the server's selection instruction.

Both transports POST only `source_row_id` and `account_identity` to the project's
codex-auth route, and refresh status after the write
(`client-core/project-chat-settings.ts:66`,
`landing/chat-react/codex-credential-client.ts:212`). Project removal uses the same
project-scoped DELETE and refreshes the result
(`client-core/project-chat-settings.ts:73`). This client change relies on the
service's grant validation and credential custody; its synthetic consumer tests
verify the route and displayed outcome rather than claiming to prove storage.

Pending or failed reads do not show the preceding project's account choices or
owner credential status (`app/components/ProjectChatSettings.tsx:22`,
`landing/chat-react/__tests__/project-chat-settings.test.tsx:44`). A refused grant
remains visible and refreshes the selectable metadata
(`landing/chat-react/SettingsTab.tsx:486`,
`app/components/ProjectChatSettings.tsx:82`).

Validation: web and phone TypeScript checks passed. The affected shared-client,
web transport, web settings, and phone settings tests passed (22 tests). Six
temporary must-fail mutations were observed and restored: transferring extra
account fields, granting on account selection without Connect, and retaining
the preceding project's credential during a pending read, each exercised on
both web and phone. The unmodified tests also exercise duplicate-paste guidance,
selected-account refusal, successful explicit connection, project-only removal,
and the writable independent-account paste.
