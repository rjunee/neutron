## 2026-09-26 — Distinguish pure ownership normalization from registry writes

The ownership guard classified the startup recovery comparison as a registry
mutation. `startup-recovery.ts:76` passes two normalized copies directly to
Node's `isDeepStrictEqual`; `repl-registry.ts:617-630` implements `disownPane`
with a rest copy, explicitly leaving local ownership bookkeeping untouched.
Both paths are under `runtime/adapters/claude-code/persistent/`.

The normative requirement remains "AN OWNERSHIP WRITE THAT COULD NOT HOLD THE
LOCK WRITES NOTHING" in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:294-311`.
Its guard description now distinguishes writes from comparison operands. This
does not change the ownership or persistence contract.

The guard masks only direct `disownPane(identifier)` operands of the directly
imported Node comparator. It uses the TypeScript syntax tree to recognize that
expression and refuses the exemption for shadowed, reassigned, aliased or
different imports. Adjacent writes, assignments inside arguments and nested
transitions remain visible. The directory scan, funnel exemption and direct
field-write guard retain their existing scope. Entry-point tracking retains
its existing lexical heuristic; this change is not a general dataflow proof.

The same test file exercises the real recovery source and a mutation in that
same comparison context, every transition under both registry entry points,
and malformed or shadowed comparison controls. A frozen-record test establishes
that normalization preserves the original input and local ownership evidence,
while retaining a changed conversation identity in the comparison result.

Validation: the original focused guard failed only on `startup-recovery.ts:76`
(three passing cases, one failure). The corrected focused file passes all nine
cases with 49 assertions. Production recovery and registry code are unchanged.
Root and Trident TypeScript checks (`bunx --no-install tsc --noEmit -p
tsconfig.json` and `bunx --no-install tsc --noEmit -p trident/tsconfig.json`)
also pass for the correction.
Full-suite, physical-session, provider and CI validation are outside this
bounded correction; the integration owner retains those receipts separately.
