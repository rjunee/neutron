## 2026-09-23 — Reuse verified dependency preparation on unchanged recovery

Part of #1196 and the preparation criterion in
`docs/spec-items/trident-build-efficiency.md`. Recovery previously ran Bun
installation on every preparation, even when the same worktree and dependencies
had already passed verification.

The host now retains an atomic preparation receipt outside the worktree. Its
identity covers the worktree path, Git revision, root and declared workspace
manifests, lockfiles, installer configuration, branch verifier marker, host
verifier bytes, runtime and resolved toolchain identity. The local dependency
directory must retain its identity. An unchanged recovery skips installation
but still runs the host verifier before admitting workers. Repositories without
the readiness contract retain their previous installation behavior.

The host retires the previous receipt before preparation and writes a replacement
only after success with unchanged inputs. Missing or malformed observations,
changed inputs and replaced dependencies require installation. Missing packages
or a failed verifier refuse admission. Borrowed root dependency directories and
Bun stores are refused. Installation retains frozen lockfiles and disabled
lifecycle scripts; verifier execution retains the host working directory and
disabled branch runtime configuration.

The consuming `open/__tests__/project-build-e2e.test.ts` passed 139 tests, including
an unchanged recovery that merges with one installation and two verifications.
Changed manifests, lockfile, configuration, verifier marker, revision, receipt,
dependency directory and toolchain each require another installation. Existing
failure, timeout, publication and branch-preload refusal cases remain covered.
Both TypeScript projects passed.

Semantic mutation checks produced assertion failures when receipt identity was
ignored, when valid recovery always reinstalled, and when reuse skipped its
verifier. Those mutations were restored. These are deterministic invocation and
admission results, not a claim of measured live wall-clock or token savings.
The broader P0 and deployed acceptance remain open.
