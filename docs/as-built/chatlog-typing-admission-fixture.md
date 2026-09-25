## 2026-09-25 — Register the chat-log typing test's project

The connect-time typing test sent a turn to `typing-project` without creating a live `projects` row. Project admission correctly refused that unknown scope, so the test waited for a typing-start frame from a turn that never began. The test harness now registers the named project before composing the graph. No production admission behavior changed.

On the base commit, the focused test passed without registration; on the admission change, it reproduced the CI `project_unknown` refusal and timed out at the second socket. With the fixture repaired, all nine tests in the consuming file pass. The real-admission unknown-project control still refuses a missing named project and admits General. Both the Open and root TypeScript checks pass.
