---
title: Require output-capable hosts at merge construction
group: trident
status: done
priority: P1
cutover: false
---

Issue #800. A fake command runner must expose its output-file obligation when
constructing merge dependencies or an orchestrator. Missing capability must be a
synchronous construction error, before commands or workflows execute.

## Decision

Require a structural output capability, supplied by production runners and the
shared fake factory. Keep the file-based measurement and its fail-closed checks.
Moving measurement into another dependency would widen the production evidence
path without improving this construction-time guarantee.

## Acceptance

- [x] A bare fake fails TypeScript and throws synchronously at both constructors,
      including an orchestrator with custom merge dependencies. The shared factory
      supplies a working alternative. Verify: `trident/testing/diff-output-host.test.ts`.
- [x] UTF-8 output and measured zero produce exact file bytes; explicitly supplied
      binary evidence is preserved. Verify: `trident/testing/diff-output-host.test.ts`.
- [x] Real production runners retain raw git file/stdout byte equality and the
      failed-command case that creates an empty file. Verify:
      `trident/testing/diff-output-host.test.ts`.
- [x] Unmeasured output still holds with `measured_bytes: null`, separately from
      zero; 1,048,576 bytes pass and 1,048,577 bytes hold. Verify: `trident/merge.test.ts`.
- [x] The existing merge-related suites keep passing: `trident/merge.test.ts`,
      `trident/orchestrator.test.ts`, `trident/arbiter-wiring.test.ts`,
      `gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts`,
      `trident/board-reconcile.test.ts`, `trident/code-command.test.ts`,
      `trident/ported-fixes.test.ts`, `trident/task-sequence.test.ts`,
      `trident/restart-resume.test.ts`, and `trident/merge-realgit.test.ts`.
