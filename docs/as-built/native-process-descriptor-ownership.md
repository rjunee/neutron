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
