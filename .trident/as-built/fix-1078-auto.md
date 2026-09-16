## 2026-09-16 — Codex rendered prompts reach a decision path

### What changed

The Codex project-session host now sends every rendered screen through a Codex-specific
classifier instead of discarding it (`runtime/adapters/codex-cli/persistent/project-session.ts:200-206`).
The classifier strips terminal control sequences, requires a recognised approval title,
and requires both numbered allow and deny choices before it reports an actionable approval
(`runtime/adapters/codex-cli/persistent/screen-prompts.ts:15-37`). It classifies the first-run
directory-trust dialog as a separate `trust` value (`runtime/adapters/codex-cli/persistent/screen-prompts.ts:20-24`).

The session exposes the latest recognised rendered prompt and answers `allow` or `deny`
through its existing acknowledged, serialized submission path
(`runtime/adapters/codex-cli/persistent/project-session.ts:121-157`). Each subsequent rendered
screen replaces the observation, including replacing it with no prompt, so stale approval
text cannot retain authority (`runtime/adapters/codex-cli/persistent/project-session.ts:200-206`).
The same spawn options are passed to new, replacement, and adopted panes
(`runtime/adapters/codex-cli/persistent/project-session.ts:212-230`).

### Decisions

The outcome vocabulary is the exported `CodexScreenPrompt` union: `approval`, `trust`, or
`undefined` when the screen cannot be classified
(`runtime/adapters/codex-cli/persistent/screen-prompts.ts:3-5`). Its defaults are fail-closed:
`undefined` produces an `unknown` error, while a positively recognised non-approval prompt
is `refused`; those outcomes do not share a branch or message
(`runtime/adapters/codex-cli/persistent/project-session.ts:127-133`).

The invariant that approval authority reflects the current rendered screen is maintained on
every host delivery by replacement, not by the process waiting for an answer
(`runtime/adapters/codex-cli/persistent/project-session.ts:200-206`). Approval responses reuse
`submitLine`, because it rejects multiline input, checks liveness, serializes concurrent input,
and awaits host acknowledgement (`runtime/adapters/codex-cli/persistent/project-session.ts:136-157`).

The issue's cited discarded callback moved from `project-session.ts:148` to
`runtime/adapters/codex-cli/persistent/project-session.ts:187` before this change; after the
change the callback is at `runtime/adapters/codex-cli/persistent/project-session.ts:205`.
The checked-out build branch also had the shorter generated name `fix/1078-auto`; the record
uses its slash-safe filename.

### Tests and mutation proof

The fake host captures the exact `onScreen` callback supplied to both spawn and attach
(`runtime/adapters/codex-cli/persistent/project-session.test.ts:24-67`). Tests exercise allow,
deny, distinct trust recognition and refusal, current-screen clearing, missing-title refusal,
and missing-deny refusal (`runtime/adapters/codex-cli/persistent/project-session.test.ts:282-337`).

| Guard | Compiling mutation | RED result | Restored result |
|---|---|---|---|
| screen registration | replace `onScreen` classifier with an empty callback at `project-session.ts:205` | 4 failures | 32 pass |
| deny selection | set `denyKey = allowKey` at `screen-prompts.ts:35` | 2 failures | 32 pass |
| trust classification | return `approval` for the trust screen at `screen-prompts.ts:22` | 1 failure | 32 pass |
| current-screen authority | retain the previous prompt when classification is empty at `project-session.ts:205` | 1 failure | 32 pass |
| trust refusal | submit the trust choice from `answerApproval` at `project-session.ts:130-132` | 1 failure | 32 pass |
| approval title | disable the title guard at `screen-prompts.ts:32` | 1 failure | 32 pass |
| complete choices | fall back to the allow key when deny is missing at `screen-prompts.ts:35` | 1 failure | 32 pass |

Final verification: `bun test runtime/adapters/codex-cli/persistent/project-session.test.ts`
(32 pass), `bunx tsc --noEmit -p runtime/tsconfig.json`, scoped ESLint over the four touched
TypeScript files, and `git diff --check` all completed successfully. The requested root
`bun run typecheck` could not run because the root package defines no such script; the scoped
runtime TypeScript project was run instead.

### Deliberately not done and not verified

No automatic trust acceptance was added: trust is observable but cannot enter the approval
answer method (`runtime/adapters/codex-cli/persistent/project-session.ts:127-133`). No feature
flag or parallel screen path was added; the prior empty callback was replaced
(`runtime/adapters/codex-cli/persistent/project-session.ts:200-206`).

This lane did not drive a live approval denial, did not re-measure queued mid-turn input under
load, and did not drive a live first-run trust dialog. The tests use screen fixtures matching
the filed issue rather than a live credentialed session. It also did not verify prompt variants
outside the four explicit approval titles enumerated at
`runtime/adapters/codex-cli/persistent/screen-prompts.ts:26-31`; an unrecognised variant remains
`undefined`, never an approval.

The local leak gate reported zero findings from every rule it could run, but its private PII
denylist was unavailable, so the PII tree and commit-message checks could not be verified
locally. The gate correctly returned its incomplete result rather than a clean result.
