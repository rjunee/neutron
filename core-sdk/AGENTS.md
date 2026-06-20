# AGENTS.md — core-sdk

This module is the published-as-npm package every Neutron Core depends on. It owns the `"neutron"` section of a Core's `package.json` — manifest types, structural validator, and the JSON Schema mirror for external tooling.

## Sprint 2B P0 surface (current)

- `types.ts` — `NeutronManifest` interface plus every supporting union: `NeutronCapability`, `TierSupport`, `LinkedSourceDef`, `BillingHookDef`, `UiComponentDef`, `ToolDef`, `ValidationResult`/`Error`/`Warning`. Strict TypeScript, zero `any`, zero `@ts-ignore`.
- `validator.ts` — `validateNeutronManifest(input: unknown): ValidationResult`. Stub-level checks: required fields present, types match, semver range parses (`isValidSemverRange`), `capabilities[]` strings are in `KNOWN_CAPABILITIES`, `tier_support[]` values are valid enum members, `linked_sources[].target_kinds` empty → warning (not error). Full body (semver-satisfies against host, billing-hook entry-point existence checks, etc.) lands P3 with the install pipeline.
- `manifest.schema.json` — hand-written Draft 2020-12 JSON Schema mirror so CI lint, the npm registry overlay, and the Cores marketplace can validate without Bun.
- `_schema-runner.ts` — minimal JSON Schema runner used only by `validator.test.ts` for the round-trip parity check. Not exported from `index.ts`.
- `index.ts` — public barrel that re-exports the manifest types and validator entry points (`@neutron/core-sdk` consumer surface).
- `validator.test.ts` — covers the eight validation cases listed in the Sprint 2B prompt plus the JSON-Schema round-trip bonus.

## What this module is NOT

- NOT the Core install runtime (P3 — `runtime/`).
- NOT a Core implementation (P3 — `cores/`).
- NOT the Cores marketplace UI or dependency resolver (P3+).
- NOT a full semver-satisfies resolver (stub-level; P3 wires this against the host's `coreSdkVersion`).

The boundary holds: `core-sdk/` is the contract surface, not an implementation surface.

## Manifest shape lock

Per locked decisions in `docs/engineering-plan.md` § B.P3 (npm-shape Core authoring) and § A.3.5 (linked-source pattern), every Core ships exactly one `"neutron"` section in its `package.json`:

```json
{
  "neutron": {
    "capabilities": ["read:gmail", "write:gmail", "..."],
    "tier_support": ["regular" | "private" | "both", ...],
    "tools": [{ "name", "description", "input_schema", "output_schema", "capability_required" }, ...],
    "ui_components": [{ "name", "entry_point", "surface": "launcher_icon|project_tab|settings_panel", "props_schema?" }, ...],
    "billing_hooks": [{ "model": "flat_monthly|usage_metered|one_time", "price_cents", "currency", "on_install?", "on_uninstall?" }, ...],
    "linked_sources": [{ "kind": "gmail|calendar|tasks|docs|memory|custom", "scope": "read|read_write", "target_kinds": ["user"|"workspace", ...] }, ...],
    "compat": { "coreApi": "<semver-range>" },
    "build": { "neutronVersion": "<host-version>" }
  }
}
```

Array fields are required-but-may-be-empty. A Core declares `"billing_hooks": []` explicitly when it has none, so absence is intentional rather than accidentally omitted. See `core-sdk/_README.md` for a fully populated sample.

## Adding a new capability (4-place edit, enforced by tests)

1. Append the literal to the `NeutronCapability` union in `types.ts`.
2. Append the same literal to `KNOWN_CAPABILITIES` in `validator.ts`.
3. Append the same literal to `$defs/NeutronCapability.enum` in `manifest.schema.json`.
4. Add coverage in `validator.test.ts` — at least a positive case in the round-trip fixture set; the negative-case test (`read:bogus`) already protects the closure assumption.

Drift between the three sources is caught by the round-trip parity test (test #9) — the JSON Schema runner sees the schema, the TS validator sees `KNOWN_CAPABILITIES`, and a fixture that lists a capability missing from one but present in the other immediately fails the parity assertion.

## Lift target

Pattern lifted from OpenClaw `packages/plugin-package-contract/src/index.ts` (`validateExternalCodePluginPackageJson`). Renames applied:

- `openclaw.compat.pluginApi` → `neutron.compat.coreApi`
- `openclaw.build.openclawVersion` → `neutron.build.neutronVersion`

The 80+ subpath split from OpenClaw `packages/plugin-sdk/` lands in P1 alongside the runtime — capability subpaths (`@neutron/core-sdk/email`, `@neutron/core-sdk/calendar`, …) are out of scope for Sprint 2B.

## Cross-refs

- `docs/engineering-plan.md` § A.3.5 — linked-source cross-project access pattern
- `docs/engineering-plan.md` § B.P3 — Core authoring package format lock
- `docs/plans/P0-system-user-data-separation.md` § 1.6 — Core SDK contract
- internal design notes — TIER-0 lift verdict
- internal design notes § 8 — `validateExternalCodePluginPackageJson` shape
