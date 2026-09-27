## 2026-09-27 — Allow a complete installed-byte observation on a busy shared host

The shared-host gate at `1ab9c418b8c7056b90ee127b4652d3cb2f851571`
executed all 1,732 discovered test files across 18 lanes with zero failed lanes,
then correctly refused a receipt because its final input identity was unavailable.
Two subsequent observations reported the installed-tree deadline. The tree walk
had only five seconds for every installed byte, local link target, transcript
validation and hash (`open/wiring/project-build-dependencies.ts:196`).

Read-only measurements against that same checkout established the timing defect.
Three sequential complete observations took 4,996, 4,822 and 4,763 milliseconds;
three concurrent complete observations took 5,148, 5,149 and 5,223 milliseconds.
All six returned the same installed identity. A later paired concurrent comparison
ran two original readers and two repaired readers: the originals returned unknown
after 5,159 and 5,225 milliseconds with deadline and probe-timeout reasons; the
repaired readers completed in 5,991 and 5,992 milliseconds with equal identities.
The later pair's digest differed from the earlier set. These measurements establish
complete, matching observations within each set, not unchanged inputs across the
entire session or a retroactive receipt for the earlier suite.

The installed-tree walk now has one 30-second wall budget, providing margin over
the measured six-second loaded observation (`open/wiring/project-build-dependencies.ts:15`).
This budget is fixed for the complete walk. Every child receives only its remaining
time in both the Python argument and process watchdog
(`open/wiring/project-build-dependencies.ts:139`). Local targets do not reset it,
and the final deadline check still rejects a complete transcript received too late
(`open/wiring/project-build-dependencies.ts:201`, `:220`). Byte hashing, ancestry
checks, change detection, link confinement, output bounds and unknown refusal stay
in place. There is no retry, cached fallback or conversion of timeout into proof.
The smaller resolved-entrypoint probe keeps its existing budget.

Regression cases exercise real native byte observations while advancing the host
clock to model scheduling delay: a valid six-second walk retains its identity,
a same-length rewrite with restored mtime changes it, and a complete late result
is refused (`open/__tests__/project-suite-identity.test.ts:181`). A linked-target
probe receives only the last 500 milliseconds and its real sleeping child is
terminated by the watchdog (`open/__tests__/project-suite-identity.test.ts:229`).
Three semantic mutations are killed by behavioral assertions: restoring the old
five-second bound, removing the final deadline check, and resetting the budget
for each batch (`open/__tests__/project-suite-identity-mutation.test.ts:17`).

Focused verification passed all 51 tests and 299 assertions across suite identity,
the native reader, semantic mutations and the consuming shared-host wrapper.
The full consuming `open/__tests__/project-build-e2e.test.ts` file passed all
367 tests and 4,767 assertions in 498.57 seconds. Both root and Trident TypeScript
checks and changed-file lint passed. The isolated purity scan of all four authored
files plus `LICENSE` passed; the whole-tree local scan reported 452 findings and
is not claimed green. These checks do not establish a complete host-suite receipt,
remote CI or deployed acceptance.

This implements the measured-input and retained-gate criteria of
`docs/spec-items/trident-build-efficiency.md:180` and `:190`, under #1196.
The historical five-second statement in
`docs/as-built/host-suite-shared-hardlink-byte-identity.md:26` describes that
earlier revision and is superseded here; immutable records were not rewritten.
