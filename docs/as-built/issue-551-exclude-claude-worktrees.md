## 2026-09-15 — Exclude tool-managed worktrees from the typecheck matrix

### What changed

The discovery excludes every \`.claude\` subtree while retaining the dependency exclusion at \`scripts/ci/typecheck-all.sh:27-32\`. The independent enumeration applies the same boundary at \`scripts/ci/ci-workflow.test.ts:80-95\`. A hermetic fixture copies the real script, creates owned and tool-worktree configs, and requires only the owned configs at \`scripts/ci/ci-workflow.test.ts:139-161\`.

The maintained invariant is “all project-owned configs, no separate tool-managed checkouts.” The shell enforces it on every query and run at \`scripts/ci/typecheck-all.sh:27-32\`; the independent walk and fixture enforce both directions at \`scripts/ci/ci-workflow.test.ts:80-95\` and \`scripts/ci/ci-workflow.test.ts:139-161\`. Neither depends on a developer-local worktree remaining available.

### Evidence and decisions

The filed line 24 citation had moved to \`scripts/ci/typecheck-all.sh:27-33\`. This checkout had 51 discoverable configs and no local \`.claude\` config, so the historical count was not reproducible here. The test therefore constructs the excluded shape.

A whole-tree \`rg\` enumeration for “EVERY tsconfig” and “every tsconfig” found live claims now corrected at \`CONTRIBUTING.md:79\`, \`.github/workflows/ci.yml:248-251\`, and \`scripts/ci/ci-workflow.test.ts:64\`. Historical hits remain in \`docs/plans/2026-07-02-world-class-refactor-plan.md:315\` and \`docs/as-built/542-quota-exhausted-honest-outcome.md:284\`; the latter is immutable under \`docs/as-built/README.md:33-36\`.

### Mutation table

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| \`scripts/ci/typecheck-all.sh:30\` excludes \`*/.claude/*\` | Removed line 30 and printed lines 27-32 | The named exclusion test failed because the result gained \`.claude/worktrees/other/tsconfig.json\` | Restored line 30, printed lines 27-33, and the same test passed: 1 pass, 0 fail |

\`bun test scripts/ci/ci-workflow.test.ts\` passed 79 tests. \`bash scripts/ci/lint.sh\` passed every sub-gate. \`bash scripts/ci/typecheck-all.sh\` enumerated 51 configs and failed only in untouched files: \`app/tsconfig.json\` could not find the \`@types\` definition; \`gateway/transcription/__tests__/whisper-install.test.ts:186\` had a typed-array overload mismatch; \`onboarding/history-import/__tests__/zip-writer.ts:10\` imported an unavailable \`node:zlib\` member; and \`logger/__tests__/fire-and-forget.test.ts:301\` passed process event names where signal names were expected. The root aggregate repeated the latter three.

The local leak scan found zero violations in the rules it could run, but exited incomplete because the external owner-PII denylist credential was unavailable.

### Deliberately not changed

No feature flag, parallel path, spec item, or product decision was added. Dynamic discovery and the dependency exclusion remain at \`scripts/ci/typecheck-all.sh:27-32\`. Historical records were not rewritten.
