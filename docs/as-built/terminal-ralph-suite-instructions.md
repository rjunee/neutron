## 2026-09-23 — Select builder suite instructions after validating the Ralph plan

The project builder brief selected the intermediate test strategy at launch whenever
one was available. Planning had not happened yet, so the final task received the same
deferral instruction as earlier tasks even when its validated remaining count was zero.

The driver now supplies a host-owned suite scope with each builder turn. Only a Ralph
build with tasks remaining gets subset scope; terminal tasks, ordinary builds, and fixes
get full-suite scope. The project host writes the matching rendered strategy into the
atomic turn context, and the immutable brief explicitly directs the builder to it.
The cheap planner's count is replaced with the measured committed-plan count before
scope selection. Review and publication receipt gates are unchanged.

This preserves the locked pivot's retained gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271`) and the intermediate/terminal
boundary in G037 and host-owned suite evidence in G063
(`docs/trident-gates-inventory.md:106`, `docs/trident-gates-inventory.md:137`).
Implementation: `trident/build-run.ts:353`, `trident/project-build-host.ts:102`, and
`open/wiring/project-build.ts:407`.

Verification: 375 tests passed across `trident/build-run.test.ts`,
`trident/project-build-host.test.ts`, `open/__tests__/project-build-wiring.test.ts`, and
the consuming `open/__tests__/project-build-e2e.test.ts`. Both
`tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json` passed. The consuming regression
continues one real fixture from intermediate task to terminal task, reading each
host-written context and its actual brief. Positive assertions find the opposite
strategy marker in its applicable task before asserting its absence in the other.

Four semantic mutations turned tests red: deferring terminal tasks and forcing full
scope on intermediate tasks each failed two driver tests; always choosing intermediate
instructions and always choosing full instructions each failed the consuming regression.
The failures were scope/strategy assertion mismatches, not parsing failures. Restoring
the source passed both driver tests and the consuming regression again.

The first sandboxed run could not bind required Unix sockets; the complete 375-test
receipt above is from the unrestricted local run. This record does not claim deployment
or a new live-run result.
