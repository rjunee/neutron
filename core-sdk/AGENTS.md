# AGENTS.md — core-sdk (ONE-RELEASE PATH SHIM, deprecated)

**X3 — one manifest contract.** The manifest contract was collapsed to a single
Zod source, **`@neutronai/cores-sdk`** (`cores/sdk/manifest.ts`). This package's
hand validator (`validator.ts`, 650 lines), its JSON-Schema mirror
(`manifest.schema.json`) and the schema runner (`_schema-runner.ts`) had ZERO
production callers and were deleted. `core-sdk` is now a thin **re-export shim**
kept for one release so existing `@neutronai/core-sdk/types.ts` importers keep
resolving. New code imports from `@neutronai/cores-sdk`.

## Current surface

- `types.ts` — type-only re-export shim; re-exports `NeutronManifest` + every supporting type (`NeutronCapability`/`KnownCapability`, `Capability`, `TierSupport`, `LinkedSourceDef`, `BillingHookDef`, `UiComponentDef`, `ToolDef`, …) from `@neutronai/cores-sdk/manifest`.
- `index.ts` — public barrel; re-exports those types plus the runtime helpers `KNOWN_CAPABILITIES`, `isKnownCapability`, `isValidSemverRange` from the single source.

## What this module is NOT

- NOT the manifest schema — that is `cores/sdk/manifest.ts` (Zod), the single source.
- NOT a validator — validation is `parseManifest` / `NeutronManifestSchema` from `@neutronai/cores-sdk`.
- NOT the Core install runtime (`cores/runtime/`), a Core implementation (`cores/free/`), or the marketplace.

## Manifest shape (owned by `cores/sdk/manifest.ts`)

Every Core ships exactly one `"neutron"` section in its `package.json`:

```json
{
  "neutron": {
    "capabilities": ["read:gmail", "write:gmail", "connect:shopify", "..."],
    "tier_support": ["regular" | "private" | "both", ...],
    "tools": [{ "name", "description", "input_schema", "output_schema", "capability_required" }, ...],
    "ui_components": [{ "name", "entry_point", "surface": "launcher_icon|project_tab|settings_panel|route_mount|app_tab", "mount_path?", "props_schema?" }, ...],
    "billing_hooks": [{ "model": "flat_monthly|usage_metered|one_time", "price_cents", "currency", "on_install?", "on_uninstall?" }, ...],
    "linked_sources": [{ "kind": "<open string>", "scope": "read|read_write", "target_kinds": ["user"|"workspace", ...] }, ...],
    "secrets": [{ "name", "kind": "byo_api_key|oauth_token|oauth_client|webhook_secret", "label", "scope?", "required", "install_prompt" }, ...],
    "compat": { "coreApi": "<semver-range>" },
    "build": { "neutronVersion": "<host-version>" }
  }
}
```

Array fields are required-but-may-be-empty.

## Capability model (open shape + known-platform set)

`CapabilitySchema` validates the OPEN `<verb>:<resource>` string — third-party /
sidecar Cores declare capabilities the platform doesn't enumerate
(`connect:google-ads`, `read:notes.db`) and they still validate + install. The
platform-KNOWN set (what X1's install gate can enforce natively) is a single
list: `KNOWN_CAPABILITIES` in `cores/sdk/manifest.ts`, consulted via
`isKnownCapability()` — consulted, never used to reject unknowns.

Adding a platform-known capability is now a single-source edit:

1. Append the literal to `KNOWN_CAPABILITIES` in `cores/sdk/manifest.ts`.
2. Add coverage in `cores/sdk/__tests__/manifest.test.ts` (+ the conformance test in `cores/runtime/__tests__/manifest-conformance.test.ts`).

## Cross-refs

- `cores/sdk/SDK-CONTRACT.md` — the live SDK contract.
- `docs/engineering-plan.md` § A.3.5 — linked-source cross-project access pattern.
- `docs/engineering-plan.md` § B.P3 — Core authoring package format lock.
