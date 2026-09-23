## 2026-09-23 — Owner-helper settlement proof no longer races its writable positive control (#1206)

The delayed-settlement fixture deliberately connected with a 250 ms helper
deadline to prove that a private settlement wait receives its own longer bound.
It then reused that same connection for an ordinary writable request. An idle
owner-helper poll may legitimately wait 500 ms, so the short connection could
close before the writable response under load even though the reviewed behavior
was correct.

The settlement assertion still uses the 250 ms connection. After the private
lease is restored and released, the fixture closes that narrowly bounded client
and reconnects with the fixture's normal 2000 ms deadline for the writable
positive control. A deterministic 350 ms native-response delay now proves both
sides of the boundary: the ordinary client succeeds, while a sibling test proves
that reusing the settlement-only deadline fails closed with an unknown outcome.
Production behavior is unchanged.

This preserves the typed-timeout and bidirectional semantic-test requirements in
`docs/spec-items/trident-build-efficiency.md:190-201`. The exact affected file
passed 23/23 after restoration and passed 20 consecutive full-file repetitions
(460 test executions total). Mutating the normal reconnect back to 250 ms made
the positive control fail; mutating the expected-timeout connection to 2000 ms
made the negative control fail because the request correctly succeeded. Both
mutations were restored. `tsc -p tsconfig.json` and
`tsc -p trident/tsconfig.json` both passed.
