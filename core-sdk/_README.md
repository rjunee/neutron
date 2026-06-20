# @neutron/core-sdk

The contract surface every Neutron Core depends on. Sprint 2B P0 ships:

- `types.ts` — the `NeutronManifest` shape and every supporting union.
- `validator.ts` — `validateNeutronManifest(input: unknown): ValidationResult` (structural stub, full body lands P3).
- `manifest.schema.json` — Draft 2020-12 JSON Schema mirror, for external tooling that can't load Bun (CI lint, npm registry overlay, marketplace).

Cross-refs: `docs/engineering-plan.md` § A.3.5 (linked sources) + § B.P3 (npm-shape Core authoring lock); `docs/plans/P0-system-user-data-separation.md` § 1.6 (Core SDK contract).

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

## Validating a manifest at install time

```ts
import { validateNeutronManifest } from '@neutron/core-sdk'
import pkg from './package.json' with { type: 'json' }

const result = validateNeutronManifest(pkg.neutron)
if (!result.valid) {
  for (const e of result.errors) console.error(`${e.path}: ${e.code} — ${e.message}`)
  process.exit(1)
}
for (const w of result.warnings) console.warn(`${w.path}: ${w.code} — ${w.message}`)
```

The same JSON Schema is exported as `manifest.schema.json` for non-Bun pipelines.

## Adding a new capability

Capabilities are intentionally an exhaustive enum; the runtime fails closed when a Core declares an unknown one. Adding one is a four-place edit:

1. Append the literal to `NeutronCapability` in `types.ts`.
2. Append the same literal to `KNOWN_CAPABILITIES` in `validator.ts`.
3. Append the same literal to the `enum` under `$defs/NeutronCapability` in `manifest.schema.json`.
4. Add coverage (positive case + a still-unknown negative case) in `validator.test.ts`.

Run `bun test core-sdk/validator.test.ts` from the repo root; the suite refuses to pass on drift between the three sources.
