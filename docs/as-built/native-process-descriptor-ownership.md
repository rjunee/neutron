## 2026-10-09 — Preserve inherited descriptors across native child finalization

Bun 1.3.13 closes a caller-owned numerical extra-stdio descriptor again when its
child wrapper is collected. If the caller already closed it and the kernel reused
the number, finalization closes the new resource. A minimal syscall-captured
control reproduced this with proven WeakRef collection: Bun lost the reused file,
while Node preserved it. Bun 1.4.2 preserved it under the identical control.

CI and all associated install-cache keys now pin Bun 1.4.2. The package and
development documentation require the verified runtime. The existing cache-pin
mutation control now changes the version independently of its current literal,
so the runtime update cannot silently disable that negative control. Historical
runtime measurements remain labelled with their original versions.

`account-writer-lock.test.ts` adds a consuming regression in a separate isolated
fixture process. It acquires a real reservation, launches the production native
transport with the existing compiled writer fixture, proves native readiness and
exit, and reuses the exact parent descriptor for another file. It proves collection
of both the returned transport and its child-owning closure before checking the
file's device/inode and writing to it. Cleanup preserves the first observed error.
The defective runtime fails at the post-collection file check; 1.4.2 passes.

Focused verification passed 33 tests and 125 assertions across the account writer,
bootstrap lease, native transport, broker recovery and owner-retirement suites.
CI policy and generated spec-index checks passed 120 tests and 663 assertions.
These results establish the local correction and regression, not a deployed
runtime upgrade or unattended Trident acceptance. The new spec keeps activation
and preserved native ownership as separate measured requirements. The mechanism
is proven; no syscall correlation is claimed for every historical subprocess
failure recorded in #1457.

The runtime upgrade also exposed two existing lifecycle/data assumptions. The
review heartbeat now owns and reaps its sleeping child on exit, so an orphan
cannot hold stderr open until the next heartbeat. All 53 review-wrapper tests
passed, including live heartbeat, post-exit silence and non-success signal exits.
Stored TEXT findings now cross SQLite as BLOB bytes and use fatal UTF-8 decoding
before parsing. SQL preserves null and rejects other storage classes before the
cast, so a BLOB containing valid JSON cannot become review evidence. A miswired
text projection throws instead of silently discarding valid findings. This covers every shared run read, both transactional guard fallbacks,
and the isolated panel reader. Invalid bytes remain empty evidence without
rewriting the database; valid literal replacement characters, emoji and
noncharacters survive, and a leading BOM reaches the existing rejection rule.
The immutable historical counting SQL remains unchanged and agrees with the
production decoder. Disabling fatal decoding failed four consuming store/panel
cases; restoring it passed the same controls. The migrated store refuses BLOB
writes at its schema boundary. The isolated panel has a non-strict table; bypassing
the shared storage-class check made its BLOB control fail, and restoration passed.

Compatibility fixtures now wait for their actual async outcome within a bounded
deadline, retain the package-resolution error code while accepting the runtime's
package-level diagnostic, and keep the runtime cache inside the token plaintext
scan but outside the simulated GitHub home. The resolution mutation now makes
malformed output falsely authoritative; the prior mutation depended on a runtime
error for a valid repository without a manifest. Both false-authority mutations
are rejected by the existing incomplete-output test.

The initial full-validation attempts stopped at lint and then typecheck. The
initial upgraded CI run exposed the compatibility failures above; those failed
receipts remain evidence. Focused correction checks pass, but the full corrected
gate and deployed acceptance remain separate requirements.
