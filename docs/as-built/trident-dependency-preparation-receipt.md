## 2026-09-23 — Reuse verified dependency preparation on unchanged recovery

Part of #1196 and the preparation criterion in
`docs/spec-items/trident-build-efficiency.md`. Recovery previously ran Bun
installation on every preparation, even when the same worktree and dependencies
had already passed verification.

The host now retains an atomic preparation receipt outside the worktree. Its
identity covers the worktree path, Git revision, root and declared workspace
manifests, lockfiles, installer configuration, branch verifier marker, host
verifier bytes, runtime and resolved toolchain identity. The local dependency
directory must retain its identity. A receipt also records the resolution targets
and file identities of every declared root/workspace dependency, including peers.
Recovery probes
these again in a fresh host-controlled process, avoiding the host's resolver
cache. Every resolved target must remain inside the worktree. Stable unresolved
optional/type probes are permitted, and local hoisting remains valid. A missing
local dependency cannot reuse an ancestor's installation as evidence: changed
resolution causes installation again. An unchanged recovery skips installation
but still runs the host verifier before admitting workers. This is resolution
evidence, not a content audit of every transitive installed file. Repositories
without the readiness contract retain their previous installation behavior.

The host retires the previous receipt before preparation and writes a replacement
only after success with unchanged inputs. Missing or malformed observations,
changed inputs and replaced dependencies require installation. An empty or missing
dependency directory, or a failed readiness verifier, refuses admission. Borrowed
root dependency directories and Bun stores are refused. Installation retains frozen lockfiles and disabled
lifecycle scripts; verifier execution retains the host working directory and
disabled branch runtime configuration.

The consuming `open/__tests__/project-build-e2e.test.ts` passed 144 tests, including
an unchanged recovery that merges with one installation and two verifications.
Changed manifests, lockfile, configuration, verifier marker, revision, receipt,
dependency directory and toolchain each require another installation. Existing
failure, timeout, publication and branch-preload refusal cases remain covered.
The ancestor regression positively demonstrates that the general verifier alone
accepts borrowed resolution before requiring the receipt path to repair it.
Its paired control retains reuse with local hoisting and an omitted optional
dependency. Peer-specific cases likewise require repair after ancestor fallback,
preserve local hoisting, and refuse to record an externally resolved peer as
reusable evidence. Both TypeScript projects passed.

Semantic mutation checks produced assertion failures when receipt identity was
ignored, when valid recovery always reinstalled, when reuse skipped its verifier,
when local resolution evidence was bypassed, and when unresolved optional probes
were incorrectly forbidden, when peers were omitted, and when external targets
were allowed into a receipt. Those mutations were restored. These are deterministic invocation and
admission results, not a claim of measured live wall-clock or token savings.
The broader P0 and deployed acceptance remain open.
