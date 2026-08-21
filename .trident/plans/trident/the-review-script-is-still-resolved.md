# IMPLEMENTATION_PLAN — harness-authoritative wrapper resolution (review half of #355)

Spec: the Plan card "The REVIEW script is still resolved from the target repo — #355 fixed only the build half". Base: main @ 47144a2a.

- [x] BUILD half (#355, merged 93ee20d1): `CODEX_BUILD_SCRIPT_PATH` exported from `trident/inner-loop.ts`, threaded as `codexBuildScript` in `buildWorkflowArgs`, consumed with NO repoPath fallback (`inner-workflow.mjs:280`), named fail-closed refusal in `forgeAgent` (`inner-workflow.mjs:1655`), dispatch/no-trident/refusal tests in `trident/__tests__/cross-model-dispatch.test.ts:592-640`, launcher-threading test in `trident/inner-loop.test.ts:490`.
- [x] REVIEW half: thread `codexReviewScript` (abs harness path of `trident/codex-review.sh`) from `trident/inner-loop.ts buildWorkflowArgs`; resolve `codexReviewSh` in `inner-workflow.mjs` with NO repoPath fallback; `codexReviewerPrompt` uses it and REFUSES by name when not threaded; update the fixture in `inner-workflow-assembly.test.ts` and the pinned-source test in `inner-workflow.test.ts`; add the dispatch/no-trident/refusal test trio mirroring the build's; add launcher-threading test; AS_BUILT entry. Acceptance: `grep -c 'repoPath}/trident/codex-review.sh' trident/inner-workflow.mjs` is 0; a review in a repo with no `trident/` resolves and runs the harness wrapper; the not-threaded case fires the named refusal and a test proves it.
- [ ] FOLLOW-UP (same defect class, out of this card's acceptance): `trident/kimi-review-cli.ts` is still resolved as `${repoPath}/trident/kimi-review-cli.ts` (`inner-workflow.mjs:4731`) — a kimi-configured review seat in any non-Open project dies the same way. Apply the identical pattern (`KIMI_REVIEW_CLI_PATH` from `inner-loop.ts`, threaded, no repoPath fallback, named refusal, tests) once this card lands.

## Do not (copied verbatim from the card's plan doc)

_Source: `docs/plans/the-review-script-is-still-resolved-from-the-target-repo-355-qhb1fd.md`. Do not paraphrase this section._

- Do not copy the script into each repo, nor script the symlink creation. Both keep two sources of truth.
- Do not let the target repo's copy win when it happens to exist — that is precisely how Open and Enterprise drifted.
