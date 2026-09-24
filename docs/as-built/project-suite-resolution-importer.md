## 2026-09-24 — Resolve suite dependencies from their manifest files

The measured-input reuse contract in
`docs/spec-items/trident-build-efficiency.md:180-188` requires a valid local
installation to retain its suite receipt while changed or borrowed dependencies
invalidate it. G063 and G065 still require host-owned suite evidence.

A live build completed its host review suite, approved the unchanged revision,
then started another full suite for publication. Both durable suite events held
only acquisition invalidations: the host had never saved a reusable receipt.
Dependency preparation had reported that resolution escaped the worktree.

The installed workspace link was correct. The host's isolated resolution probe
passed a package directory as Bun's importer instead of an importing file.
An ancestor permission boundary allowed traversal but denied directory listing;
a cold Bun directory-importer lookup skipped the importing package in that
layout. For one scoped workspace dependency it selected an ancestor checkout even
though the package-local link pointed into the reviewed worktree. A read-only
probe across all declared dependencies measured 365 local, 13 unresolved and
one external resolution with the directory importer. Changing only the importer
to the absolute manifest file measured 366 local, 13 unresolved and no external
resolutions. The same resolution probe from the project's working directory
selected the local workspace correctly.

`open/wiring/project-build-dependencies.ts` now supplies that manifest file.
The probe still runs in the host directory with branch configuration and dotenv
loading disabled. Every resolved target must still remain inside the worktree;
unknown inputs still cannot produce a reusable receipt. Receipt identity,
revision/round ownership, full-suite scope and publication gates are unchanged.

The consuming regression in `open/__tests__/project-build-e2e.test.ts` places a
correct package-local scoped workspace below an ancestor that denies listing,
beside a stale ancestor dependency. It positively checks the listing refusal,
successful local code consumption, preparation reuse and one host suite through
review and publication. Reverting only the importer produced a missing-receipt
failure after local execution passed; the valid hoisting sibling remained green.
Removing realpath confinement separately caused the external-peer refusal test
to fail while the valid local case still passed. Restoring the guards passed all
three focused cases. A separate unchanged full-repository reproduction returned
a stable suite identity with the fix, null with the old importer, and the same
identity after restoration.

The consuming Open end-to-end file and project-build host tests exercised 331
cases: 322 passed in the initial invocation and nine socket cases were refused
by the execution sandbox. Those same nine passed when rerun with local socket
access; the initial failed invocation was retained rather than called green.
Both required TypeScript projects passed. Deployed unattended acceptance remains
part of #1196.
