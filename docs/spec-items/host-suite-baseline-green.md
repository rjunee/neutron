---
title: Host suite passes at baseline on a capacity-pinned host
group: trident
status: open
priority: P0
cutover: true
---

# Host suite passes at baseline on a capacity-pinned host

Refs #1261.

The trident host suite (`bun run test` → `bash scripts/run-tests.sh`) must be
green at `main` with no diff applied on a build host that carries a provisioned
Claude capacity pin. While it is red at baseline, every build's host suite fails
on failures it did not cause, a head-neutral fix round cannot move the branch,
and no build can merge autonomously.

## Causes and their owners

1. **Provisioned capacity pin.** `loadClaudeCapacityPin()`
   (`runtime/workers/claude-capacity-client.ts`) reads the host-provisioned pin
   directory. A present pin never falls back, so fake children that model an
   unregistered self-host cannot register with the host relay. Every Linux
   `bun test` invocation already runs inside the private mount namespace from
   `tests/support/process-test-isolation-preload.ts`, and
   `trident/process-test-isolation.py` mounts an empty tmpfs over that pin
   directory there. That makes the suite hermetic against the pin (from
   `918902da4`, after the base of the run that reported this). Fixtures that
   need a pin provide their own signed pin and socket.
2. **Package-launcher environment.** `bun run test` exports `npm_*`, `BUN_*`
   and `NODE` into the runner. The production package-identity probe
   (`bunPackageLauncherIdentity`, `open/wiring/project-build-dependencies.ts`)
   correctly refuses any inherited launcher variable, so the tests that measure
   a fixture's portable launcher saw the suite's own launcher instead. CI runs
   `bash scripts/run-tests.sh` directly and never saw this.

## Requirements

- `scripts/run-tests.sh` unsets the probe's predicate names (`npm_*`, `NPM_*`,
  `BUN_*`, `NODE`, `NODE_*` except `NODE_ENV`, and a non-empty `ENV`) on entry,
  for its test processes only. The probe itself is unchanged.
- No environment variable, flag or file may let a production process skip a
  present capacity pin. A present broken pin still refuses with
  `repl_unreconciled`.
- `loadClaudeCapacityPin` accepts a directory argument, defaulting to the
  provisioned directory, so a positive control can prove that a present,
  untrusted pin refuses in every consumer: the loader, the route fingerprint
  and native relay preparation. The fingerprint and the relay accept an
  injected pin source. Omitting it selects the production loader.
- No test is deleted, skipped or marked `.todo`.

## Acceptance

- A runner selftest proves that the discovery probe and every lane receive no
  launcher variable, while `NODE_ENV` and unrelated variables survive.
  Removing the scrub turns it red.
- The positive control turns red if a broken present pin is made to return
  `undefined`.
- On the build host, the full `bun run test` is green in every lane.

## Follow-up (separate card)

`trident/build-run.ts` treats a head-neutral fix round that only proves
failures preexisted as lost work. That gate change cannot land through the gate
it fixes.
