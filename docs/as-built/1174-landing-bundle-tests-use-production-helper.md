## 2026-09-19 — Landing bundle tests use the production build boundary (#1174)

The G063 live run at `bb6065b4` failed
`landing/__tests__/chat-react-bundle-production-runtime.test.ts` when Bun reported
`Unexpected reading file` for React and workspace modules. The repository's locked
runner diagnosis had already measured this Bun 1.3.13 failure family under
general-lane concurrency: the landing bundle files were green file-scoped, while
in-process `Bun.build` calls could read through stale test-loader resolver and file
descriptor state in a shared test process
(`.trident/plans/trident/3-main-s-local-suite-is-red-50-file.md:148-155`). A later production repair moved the
server's development fallback build into a fresh Bun child, but the two direct
bundle regression tests continued to bypass that boundary and call `Bun.build`
in-process.

The production helper is now exported and both bundle tests call it. Its CLI
arguments are derived from `CHAT_REACT_BUNDLE_BUILD_OPTIONS`, preserving one source
of truth for the browser target, module format, minification, sourcemap and
production `NODE_ENV` define (`landing/server.ts:638-685`). The production-runtime test still inspects the built
bundle text and retains every positive and negative assertion; the build-smoke test
still prints the child bundler's diagnostics on failure
(`landing/__tests__/chat-react-bundle-production-runtime.test.ts:29-57`;
`landing/__tests__/chat-react-bundle-builds.test.ts:23-32`).

Fresh, fully installed worktrees at the failing revision and current base were used
to distinguish an install defect from the intermittent Bun race. On both revisions,
the production-runtime file passed three consecutive isolated runs. The exact
100-file general chunk containing the four landing bundle/serving files then passed
1,093 tests with zero failures three consecutive times on each unmodified revision,
so the historical failure did not reproduce deterministically; dependency
installation was complete in both worktrees. This agrees with the recorded
file-scoped-green, aggregate-intermittent signature rather than a missing-workspace
dependency failure.

The repaired four-file surface passed 40 tests with zero failures three consecutive
times. The same reconstructed 100-file concurrent chunk passed 1,093 tests with zero
failures after the change. Two temporary mutations proved that the assertions were
not weakened: changing the shared define from production to development failed with
951 `jsxDEV`, 6 `console.createTask` and 7 `OwnerStack` occurrences; changing the
entrypoint to a valid but wrong landing module failed at the `car-conv` positive
control. Both mutations were restored before commit.

Root, `landing/`, and `landing/chat-react/` TypeScript checks completed with zero
errors. The explicitly requested consuming check
`open/__tests__/project-build-e2e.test.ts` passed 89 tests with zero failures and 818
assertions. `git diff --check` was clean.
