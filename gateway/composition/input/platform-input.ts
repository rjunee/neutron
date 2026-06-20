import type { PlatformAdapter } from '../../../runtime/platform-adapter.ts'

export interface PlatformCompositionInput {
  /**
   * Sprint B (2026-05-20) — PlatformAdapter. The logical seam between
   * Open (self-hosted single-instance) and Managed (hosted
   * VPS). REQUIRED for every `composeProductionGraph` caller — the
   * graph exposes the adapter as a module so other modules can resolve
   * it via `graph.get<PlatformAdapter>('platform')` instead of
   * importing Managed-classified primitives directly.
   *
   * Production wires `ManagedPlatformAdapter` (via
   * `gateway/index.ts:boot`); the M2 onboarding fixture continues to
   * produce a byte-identical emit sequence because the Managed adapter
   * is a thin shim around the existing instance-provisioning / proxy /
   * identity / signup call chains.
   *
   * The Sprint B integration test
   * (`tests/integration/local-platform-adapter-boot.test.ts`) wires
   * `LocalPlatformAdapter` and asserts the same emit sequence + phase
   * transitions on the Open path.
   *
   * Tests that don't reach the adapter can pass a synthetic
   * `buildLocalPlatformAdapter({ selfOwner: <stub> })` in three lines.
   * The pre-Sprint-B optional (`platform?:`) was dropped on 2026-05-20
   * so consumers cannot silently bypass the seam.
   *
   * Per docs/research/neutron-open-vs-managed-architecture-2026-05-17.md
   * § 2.4 + § A + SPEC.md § Phases→Steps (Sprint B).
   */
  platform: PlatformAdapter
}
