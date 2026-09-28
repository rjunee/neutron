## 2026-09-28 — Manual Codex account rotation in General Admin

The authenticated global Codex operator routes existed, but the web Admin pane
had no caller for rotation. The owner can now read the stored active account and
switch to the next available account from the Codex section. The browser client
sends `GET /api/app/codex-auth/rotation` and `POST /api/app/codex-auth/rotate`
with an empty JSON object through its existing bearer transport. It never sends
credential bytes for this action or renders the bearer. The control disables
when metadata has no available alternate, stays busy through the confirming read,
and displays either the selected account or an explicit refusal. The server
remains the authority for eligibility; a 409 cannot be shown as success. No
automatic rotation policy or cooldown release was added.

The focused client and Admin component suites cover the authenticated route,
empty POST body, successful selection, disabled single-account state and 409
refusal. Delayed-read regressions confirm a second switch cannot run until the
first selection read settles and an older response cannot overwrite a newer
selection. Removing either guard makes its regression fail.
One shared immediate mutation guard now serializes switching with connect and
disconnect, including same-tick form submits; each control stays disabled through
its confirming metadata read. A 409 re-reads the stored pointer and cooling
metadata while retaining the refusal. This read cannot establish credential
health, so the server still decides eligibility on the next attempt.
The app-shell test mounts actual General via the global tabs route at narrow and
wide widths, with a named-project negative control. Both landing TypeScript
projects and the root and Trident projects were checked in this worktree. This
UI closes the owner-facing part of issue #1348; the credential custody and HTTP
surface are recorded separately in `docs/as-built/codex-operator-custody.md`.
