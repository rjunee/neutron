## 2026-09-29 — Reconcile authenticated late native panel results

The restart contract requires the original signed child-bound request, canonical
attempt, exact armed reservation, canonical result path and live validators
(`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:502`). Recovery
previously recognized only flat role artifacts, while the live review panel
writes a verdict under its retained review identity. This left completed panel
review and synthesis children fenced after the workflow had failed.

The live producer and passive reader now share artifact and step derivation
(`trident/project-review-artifacts.ts:4`, `trident/project-review-source.ts:121`,
`:269`). Recovery matches the signed request against those paths and the existing
review receipt's request hash and original request file, using the existing
receipt reader (`open/wiring/claude-native-dispatch-reconcile.ts:92`). It then
uses the same armed reservation and `decodeProjectTrailer` / live verdict
validator as ordinary execution (`:75`, `open/wiring/project-build.ts:1060`).
Only the authenticated original lease is released. The run and attempt remain
unchanged; no actor is created or replayed.

Focused validation on the change based on
`322e354a0186342edd65243e83c010a760d25d11`:

- Root, Open and Trident TypeScript checks passed:
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json`, with the corresponding
  `open/tsconfig.json` and `trident/tsconfig.json` invocations.
- `bun test open/wiring/__tests__/claude-native-dispatch-boot.test.ts`:
  81 passed, including both roles, completed/blocked results, duplicate and
  foreign leases, malformed evidence, and actual Open startup/periodic recovery.
- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern
  'passive late panel|prepared panel recovery reconciles a lost acknowledgement|prepared pending panel refuses|native child durable ownership follows'`:
  11 passed. Four new cases consume artifacts from the actual live panel producer;
  existing cases preserve ordinary validation and pending-reservation behavior.
- Semantic mutations were applied and restored. Disabling panel recovery killed
  all four boot positives and all four consuming E2Es. Bypassing envelope/payload
  validation killed eight negative cases; reservation validation killed four;
  signed lease validation killed six token/generation/forgery controls; canonical
  artifacts and retained claim validation killed sixteen. The consuming E2Es also
  all failed when envelope/payload validation was bypassed. Restored suites passed.

These are offline fixture results, not live acceptance or a complete repository
suite receipt. No live run, lease, database, model selection, or pending request
was changed. Missing results remain fenced. Provider TaskStop text and transcript
cessation are not completion authority. Publication, CI, deployment and the next
live acceptance remain separate work.
