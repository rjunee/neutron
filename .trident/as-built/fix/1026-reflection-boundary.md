## 2026-09-15 — Restore G137 on rebuilt project briefs

### Boundary and cause

Issue #1026 restores the existing product intent. The boundary in
`open/composer.ts:7215-7218` says:

> thread the owner's structured CORRECTIONS into the inner
> workflow so the FORGE BUILDER (forge:build + fix rounds) re-grounds on
> them — NOT the independent argus review gate

The construction loop enumerates plan, build, review and fix at
`open/wiring/project-build.ts:102`. The surrounding block already applies:

```ts
writable: role !== 'review', network: role !== 'review',
tools: role === 'review' ? 'read-only' : 'edit-and-run',
```

Those grants are at `open/wiring/project-build.ts:120-121`; schema and result
path are role-specific at :123. This is evidence of an omitted guard, rather
than a deliberate relaxation of reviewer independence.

### Implementation and decisions

- `open/wiring/project-build.ts:109-115` restricts reflection and test execution
  instructions to build/fix. Plan is excluded by the same explicit allowlist.
- Reflection uses the shared `buildReflectionGuidance` at :115, appended AFTER
  the contract. Its framing requires that ordering
  (`trident/reflection-guidance.ts:31-39`, :89-91). Escaping and the escaped-data
  cap remain owned by that helper (:53, :65, :98).
- Import is permitted: `.dependency-cruiser.cjs:15-16` permits lower-band
  imports; open is composition (:64), trident is services (:54).
- Test strategy has its own measured basis: `trident/orchestrator.ts:2187-2189`
  says “FORGE build contract only — never the argus review gate”. The old
  contract explicitly covers build and every fix round
  (`trident/inner-workflow.mjs:182-189`). It remains above the numbered role
  contract in the rebuilt brief (:110-114). The host's suite policy still
  receives it at `open/wiring/project-build.ts:144`; the brief boundary does
  not disable host evaluation.
- The continuously applied mechanism is the host-owned brief construction
  allowlist before write/seal (:109-122), independent of worker cooperation.
  Host consumption verifies those sealed bytes
  (`trident/project-build-host.ts:67-78`). This restores a routing invariant;
  it introduces no new error, verdict or state requiring taxonomy handling.
- All four roles are enumerated in `open/__tests__/project-build-wiring.test.ts:262`.
  Nonempty build/fix positive controls at :273-275 accompany plan/review
  exclusion. Exact brief equality at :276-285 preserves the task, role,
  schema and publish prohibition, and preserves builder strategy byte for byte.
  The raw reflection slot and its separator become an advisory suffix;
  contract text is unchanged. Integrity and host strategy are checked at :286-287.
- The delimiter fixture at :293 contains a real closing tag and independent
  injected tag. Assertions at :297-300 require escaped data, exactly one closing
  delimiter, framing, and placement after the contract. The oversized escaped
  data check is at :304-311.

### Mutation evidence

Every mutation ran `bun test open/__tests__/project-build-wiring.test.ts`.
Changed lines were printed before execution; failures were assertion failures.
The reflection-guard mutant additionally passed
`bunx tsc -p open/tsconfig.json --noEmit` (exit 0).

| Guard/property | Mutation and landing line | Red result | Restored green |
| --- | --- | --- | --- |
| Reflection role boundary | :115, unconditional `buildReflectionGuidance(input.reflection_context)` | 11 pass / 2 fail, plan and review at test :273 | 13 pass / 0 fail |
| Strategy role boundary | :110, unconditional `input.test_strategy ?? ''` | 11 pass / 2 fail, plan and review at test :274 | 13 / 0 |
| Builder positive control | :115, replace guidance suffix with empty string | 9 pass / 4 fail | 13 / 0 |
| Shared framed derivation | :115, raw reflection instead of helper | 9 pass / 4 fail | 13 / 0 |
| Escaping | `trident/reflection-guidance.ts:98`, bypass `escapeData` | 11 pass / 2 fail | 13 / 0 |
| Escaped-data cap | helper :98, replace cap argument with `Number.MAX_SAFE_INTEGER` | 12 pass / 1 fail | 13 / 0 |

Unqualified production mutation lines above are in `open/wiring/project-build.ts`.
The helper mutations were temporary and restored. Final focused test run:
13 pass, 0 fail, 91 assertions, one file. Targeted ESLint for both changed
TypeScript files passed (exit 0). Final restored
`bunx tsc -p open/tsconfig.json --noEmit` passed (exit 0).
`git diff --check` passed; the record has exactly one `## ` heading.

### Scope

The filed orchestrator citations moved: reflection intent is now :2181-2186,
and strategy intent is :2187-2189, rather than the filed :2195-2196.
The helper cap constant is :65 and escaping is :53.
No product decision changed. This change deliberately leaves reflection loading,
the correction judge, orchestration, gate implementations and build-run untouched.
It does not add planning guidance, reimplement the helper, or run the full suite.
The as-built location follows the explicit lane instruction for this change.
