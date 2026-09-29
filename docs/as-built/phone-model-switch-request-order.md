## 2026-09-29 — Scope the phone switch race's request evidence

Governing item: `docs/spec-items/repl-model-background-poll-test-stability.md`
(#1320). The full host run of `3fc71c343acbf3b4e41894da8058adb070396bad`
recorded 428 passing tests and one failure in its 43-file device lane: the
session-A switch test expected the final recorded call's body to be the POST
body, but received null. That positional assertion was at
`app/__tests__/repl-model-control.test.tsx:254` in the frozen revision.

The stub records process-global fetches (`app/__tests__/repl-model-control.test.tsx:45-65`).
Other chat mounts can keep polling:
`app/__tests__/chat-jump-to-bottom.test.tsx:79-90,105-165` mounts chat screens
without unmounting them, `app/components/ChatSyncSurface.tsx:851` mounts the
model control, and `app/components/ReplModelControl.tsx:56-68` schedules its
reads. The exact emitter
in the failed host run was not logged. A controlled later GET reproduces the
same null-body failure while the switch POST remains pending.

The session-A test now selects the exact model URL and POST method and verifies
exactly one request with the expected model, session and auth token. It issues a
controlled unrelated GET and positively verifies that this read followed the
POST (`app/__tests__/repl-model-control.test.tsx:250-266`). The existing focus
refresh to session B and delayed session-A acknowledgement still exercise the
consumer (`:268-279`). No production source or timeout changed.

Local evidence was collected in an isolated worktree based on the frozen
revision. The untouched focused file passed 18/18 and the untouched device lane
passed 429/429; this does not erase the earlier host failure. Adding the later
GET with the former positional assertion made the focused case fail (0 pass,
1 fail) and the same 43-file lane fail (428 pass, 1 fail). The scoped assertion
then passed the focused file (18 pass) and device lane (429 pass, 0 fail).
The lane inventory came from the runner's 1,756-file plan and its content-derived
membership (`scripts/run-tests.sh:363-397`), with the host run's existing
`--timeout=15000 --max-concurrency=16` settings (`:792-803`).

Temporary semantic mutations each failed their focused consumer: removing the
background generation check displayed cheap after the switch; discarding every
GET prevented the positive focus-read case from switching; allowing only the
initial focus GET left unknown after the fresh response; and removing the POST
generation check displayed frontier after session B had displayed other.
These checks exercise `app/components/ReplModelControl.tsx:39,61,74,98` through
`app/__tests__/repl-model-control.test.tsx:148-166,249-279,327-345`.
All mutations were restored, the production file matched the frozen source,
and the focused file passed 18/18 again. Root, app and Trident TypeScript checks
passed (`bun x tsc --noEmit`, plus `-p app/tsconfig.json` and
`-p trident/tsconfig.json`).

These are focused and co-resident consumer results, not a completed full-host
receipt or served-product verification. The combined publication candidate
still requires its full host receipt and exact-head CI.
