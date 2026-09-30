## 2026-09-30 — Align the cap rearm recovery fixture with the current project REPL tools

The operator cap rearm test recorded a capped session with the older
`LIVE_AGENT_TOOL_NAMES` surface. Native continuation added the continuation tool
to the shared `PROJECT_REPL_TOOL_DEFS` surface consumed by Open's startup recovery.
After an authorized cap release, the normal scheduler correctly refused to
resume the fixture: its retained tool profile no longer matched the current one.

The capped-session fixture now records the names from `PROJECT_REPL_TOOL_DEFS`.
The production startup identity check remains unchanged. The isolated Open test
proves both that an unresolved native child keeps the cap held and that a signed
release on the current scope permits the existing scheduler to resume the
recorded session. It passed with 21 assertions. Replacing its profile with the
older list made that test fail at the expected resume assertion; this was a
fixture regression control. The separate changed-tools startup test passed.
In temporary production-guard mutations, rejecting every tool profile made the
legitimate cap test fail, and accepting every profile made the changed-tools
refusal test fail by resuming a changed session. The guard was restored. Root,
Open and Trident TypeScript checks passed. This is local integration evidence,
not a live operator action or deployment receipt.
