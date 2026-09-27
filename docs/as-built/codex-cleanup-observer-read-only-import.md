## 2026-09-27 — Keep cleanup-observer imports out of measured dependency inputs

A successful deployed host suite was correctly refused when its installed-input
identity changed. The run's per-entry before/after records were unavailable after
terminal cleanup, so no historical receipt is transferred or retrospectively
accepted. A bounded reproduction at the original candidate revision isolated a
concrete writer: the cleanup-observation shim in `trident/codex-build.test.ts:399`
imports the real lane owner with `importlib`, which created Python bytecode in
the linked first-party workspace. The repository ignores that cache in git;
ignored does not mean absent from the installed-input contract.

The actual deployed reader observed 89,163 entries before the single
`unknown cleanup leaves the shipped primary brief refusal byte-exact` test and
89,165 afterward. The only additions were `trident/__pycache__` and its
18,928-byte `lane-processes` bytecode file. There were no changed normalized
surviving records, removals or surviving traversal-order changes. Two completed
before captures agreed. This is a real input addition, not directory timestamp
noise or a reason to weaken the observer.

The shim now sets `sys.dont_write_bytecode` before importing the owner. The
production identity reader and its refusal behavior are unchanged. The real
cleanup still runs, including its unknown-closure observation. A paired fixture
uses the generated shim and copied real owner: the normal import leaves no cache,
while disabling suppression creates one (`trident/codex-build.test.ts:1237`).
A same-layout copied-test positive passed; removing suppression from that shim
produced a semantic assertion failure, expecting no cache and observing a cache.
Neither result depends on a parser failure.

With the corrected tests, the deployed reader measured the same identity and
89,183 entries before and after the narrow cleanup checks. Those checks passed
two tests and 13 assertions. The explicitly invoked consuming E2E checks passed
four tests and 49 assertions, covering real Python imports both with and without
suppression alongside existing scratch and hardlink siblings. The writing case
still refuses the first receipt and requires a new suite; the non-writing case
reuses its proven receipt (`open/__tests__/project-build-e2e.test.ts:2647`). Root
and Trident TypeScript preflights passed.

This preserves the measured-input and both-direction requirements in
`docs/spec-items/trident-build-efficiency.md:180` and `:190`. A candidate retaining
the old test writer must be legitimately refreshed and prove its new inputs;
deploying this fixture fix cannot change an already-frozen old candidate. The
coordinated complete gate, exact-head CI and fresh deployed evidence remain
required. Focused reproduction is not a claim of unattended live success.

The coordinated local `bash scripts/check-shared-host.sh` gate subsequently passed at frozen revision
`f3d25471cb8f3b26ceaaafc580f8e62310644d61`: all 51 TypeScript configurations
and all 1,731 declared, discovered, assigned and executed files passed across
18 lanes, with zero failed lanes. Both the gate and its identity wrapper exited
zero. Production suite identity remained
`c9ffc4c615188044bf0cb893b723a3545bdf28a2d320c815aa9a4e70c42b4144`
before and after; installed-tree identity remained
`c483f22c85019e8a2e629b8b450b726a51a69a69754b2a7e0d0266b8db16c28d`.
The tested head stayed clean and unchanged. This paragraph is recorded after
that gate; it does not transfer the receipt to the later publication identity.
Exact publication-head CI, deployment and fresh live acceptance remain separate.
The retained complete gate log has SHA-256
`24ca8aa18dc8ba1e284208f6bf4c6b53496cfb2f9c6193994723e17e1fac7e98`;
its before/after identity artifact has SHA-256
`0aa6b4a12350482cb80eab910fd663dc90f5d8a016d7b2d272374dcbba732a41`.
