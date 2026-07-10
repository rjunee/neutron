# @neutronai/core-sdk — ONE-RELEASE PATH SHIM (deprecated)

> **X3 — one manifest contract.** The two former validators were collapsed to
> a single Zod source, **`@neutronai/cores-sdk`** (`cores/sdk/manifest.ts`).
> This package's 650-line hand validator (`validator.ts`), its JSON-schema
> mirror (`manifest.schema.json`) and the schema runner had ZERO production
> callers and were **deleted**. `core-sdk` now only RE-EXPORTS the pure
> manifest types + the platform-known capability helpers from the single
> source so existing `@neutronai/core-sdk/types.ts` importers keep resolving
> during the deprecation window.
>
> **New code MUST import from `@neutronai/cores-sdk`.**

- `types.ts` — re-export shim (the `NeutronManifest` shape + supporting types, sourced from `@neutronai/cores-sdk`).
- `index.ts` — barrel re-exporting the types + `KNOWN_CAPABILITIES` / `isKnownCapability` / `isValidSemverRange` from the single source.

Cross-refs: `docs/engineering-plan.md` § A.3.5 (linked sources) + § B.P3 (npm-shape Core authoring lock); `cores/sdk/SDK-CONTRACT.md` (the live contract).

## Sample Core manifest

A Core's `package.json`:

```json
{
  "name": "@neutron/core-email",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "neutron": {
    "capabilities": [
      "read:gmail",
      "write:gmail",
      "read:project_data",
      "write:project_data",
      "network:external"
    ],
    "tier_support": ["regular"],
    "tools": [
      {
        "name": "list_threads",
        "description": "List Gmail threads in the user's inbox.",
        "input_schema": {
          "type": "object",
          "properties": { "limit": { "type": "number" } }
        },
        "output_schema": {
          "type": "object",
          "properties": { "threads": { "type": "array" } }
        },
        "capability_required": "read:gmail"
      }
    ],
    "ui_components": [
      {
        "name": "EmailLauncher",
        "entry_point": "./ui/EmailLauncher.tsx",
        "surface": "launcher_icon"
      }
    ],
    "billing_hooks": [{ "model": "flat_monthly", "price_cents": 999, "currency": "USD" }],
    "linked_sources": [{ "kind": "gmail", "scope": "read", "target_kinds": ["user", "workspace"] }],
    "compat": { "coreApi": "^1.0.0" },
    "build": { "neutronVersion": "0.1.0" }
  }
}
```

## Validating a manifest

Use the single Zod schema from `@neutronai/cores-sdk`:

```ts
import { parseManifest, safeParseManifest } from '@neutronai/cores-sdk'
import pkg from './package.json' with { type: 'json' }

// throws z.ZodError on invalid input
const manifest = parseManifest(pkg.neutron)

// or non-throwing:
const result = safeParseManifest(pkg.neutron)
if (!result.success) {
  for (const issue of result.error.issues) {
    console.error(`${issue.path.join('/')}: ${issue.message}`)
  }
  process.exit(1)
}
```

There is no separate JSON-Schema mirror any more; the Zod schema is the one
source. `compat.coreApi` semver-range syntax is validated by the schema
(`isValidSemverRange`, folded into `cores/sdk/manifest.ts`).

## Adding a new PLATFORM-KNOWN capability

The manifest `CapabilitySchema` is deliberately **open** — any well-formed
`<verb>:<resource>` string validates, so third-party / sidecar Cores declare
capabilities the platform doesn't enumerate and they still install. The
platform-KNOWN set (what X1's install gate can enforce natively) is a single
list now:

1. Append the literal to `KNOWN_CAPABILITIES` in `cores/sdk/manifest.ts`.
2. Add coverage in `cores/sdk/__tests__/manifest.test.ts`.

(The old four-place edit — closed union in `types.ts`, `KNOWN_CAPABILITIES` in
`validator.ts`, `manifest.schema.json` enum, and `validator.test.ts` — is gone;
they collapsed to this one source.)
