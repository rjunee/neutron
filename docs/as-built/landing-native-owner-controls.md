## 2026-09-25 — Native owner controls reach the bundled web chat

The Open composition mounts the landing server (`open/composer.ts:2464`,
`:7533`), whose SPA serves the React project shell (`landing/server.ts:1310`).
That shell consumes `landing/chat-react/ReplModelControl.tsx` at
`ProjectShell.tsx:795`; it is separate from the Expo component. The web control
previously exposed only model selection. This slice adds the existing Codex
owner interrupt, approval, and supported question actions to that consuming
surface; it does not claim a deployed live witness.

`landing/chat-react/native-owner-control-client.ts:28` validates the requested
scope and every pending question's native thread/turn. General is explicit null
in identity and `~general` only in the HTTP path (`:62`); the literal project
`general` remains distinct. Actions carry the complete observed identity (`:51`)
and reject acknowledgements from a replacement thread, binding, or generation.
`NativeOwnerControl.tsx:18` polls read state; `:44` serializes writes and never
retries them. Request generations discard stale responses after a scope change.
The model control mounts these actions for ready or busy Codex owners, and
unmounts them for other harnesses. Unsupported questions retain a terminal notice.

Focused verification covers the rendered model control and the actual
`ProjectShell`, including General and a project named general, full action
payloads, approvals/input/interrupt, foreign scope and pending-turn refusal,
replacement acknowledgements, and a late General response after changing scope.
The existing model-selector fixture now uses Claude, keeping its model-only
assertions independent of the separately exercised Codex actions.

Both mutation directions were measured and restored: removing response scope
equality makes all three wrong-General-identity cases fail; suppressing the
native control makes both consuming ProjectShell cases fail. These are runtime
render/action checks, not source-text matches.

Local scoped commands: `bun test
landing/chat-react/__tests__/native-owner-control.test.tsx
landing/chat-react/__tests__/repl-model-control.test.tsx
landing/chat-react/__tests__/project-shell.test.tsx`, plus `bunx tsc --noEmit -p
landing/chat-react/tsconfig.json` and `bunx tsc --noEmit -p landing/tsconfig.json`.
The focused run passed 38 tests with 221 assertions; both TypeScript commands
exited zero after restoring the mutations.
The canonical shared-host checks, integrated app/web head, CI, and deployed
controls are separate publication evidence; they have not run for this slice.
