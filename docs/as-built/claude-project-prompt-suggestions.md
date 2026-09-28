## 2026-09-28 — Keep generated suggestions out of Claude owner composers

Issue #1400; normative scope is
`docs/spec-items/claude-project-prompt-suggestions.md`.

The conservative composer check treats visible text as occupied, including dim
generated suggestions (`runtime/workers/claude-composer.ts:8-21`). The unattended
dispatch checks that screen before submission
(`runtime/workers/claude-acting-turn.ts:299`). Open now supplies
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` when constructing project and General
owner sessions (`open/wiring/substrates.ts:286`), using the existing environment
overlay (`gateway/wiring/build-llm-call-substrate.ts:879-887`). This follows the
[provider's documented suppression setting](https://code.claude.com/docs/en/interactive-mode#turn-prompt-suggestions-off).

The same project conversation continues dispatching native Agent work. The
rendered composer guard is unchanged; existing suggestions, real drafts, busy
screens and unreadable screens continue to refuse without text or Enter.
Adopted live processes do not receive a new environment. Direct terminal users
of newly created project and General owner sessions lose generated suggestions.
No live process was restarted or altered to validate this change, and this
record does not attribute a historical refusal to suggestions or claim a live
unattended merge.

Validation on the dirty implementation based on
`2b07646c76f358227c3edf1438969fe210c324be`:

- `bun test runtime/workers/claude-composer.test.ts open/__tests__/open-wiring-substrates.test.ts`:
  66 passed, 320 assertions, including the final rerun after mutation restoration.
- `bun test open/__tests__/project-build-e2e.test.ts -t 'adopted project composer'`:
  5 passed, 31 assertions. Four refused without input RPCs; the empty composer
  completed the fixture build through Herdr. Provider behavior and GitHub are
  fixture seams, not a live deployment proof.
- `node_modules/.bin/tsc --noEmit -p open/tsconfig.json` and the corresponding
  `runtime/tsconfig.json` command both exited zero.
- `bun test scripts/__tests__/spec-items-index.test.ts`: 38 passed, 428 assertions;
  the generated index matches the new spec item.
- Mutation controls failed as intended: switching suppression to `true` failed
  the owner assertion; applying it to phase-spec failed the unrelated-session
  assertion; an always-accept composer failed 14 refusal cases; an always-refuse
  composer failed 4 ready cases. Every mutation was restored; the production
  composer file has no diff against the base.

After independent implementation and cross-model review, the candidate was
rebased without conflict onto `cf259ed61`. Root and Trident TypeScript checks
and the affected 66-test and 5-test subsets passed again on candidate
`0571bbb9c3c23ea78794ebfdee73b504801b260e`.

`bash scripts/check-shared-host.sh` exited zero on that candidate: all 51
TypeScript configurations passed; all 1748 discovered test files executed
(1510 general, 22 PGLite, 43 device, 173 real-HTTP), with zero failed lanes
across 19 bounded-memory lanes. The wrapper measured unchanged suite input
identity `fb0ebc6fed2ff16c9e44d32a3096206a179339f935a5c088e2f5ce41c09ec61f`.
This receipt records that tested candidate, before this documentation-only
receipt update; it does not assert a fresh full-suite run on the publication
commit. Required CI still applies to the final publication head.

A separate local whole-worktree leak scan reported baseline and worktree
metadata findings under the local denylist. It is not a clean purity receipt;
the required CI purity gate remains authoritative for publication.
