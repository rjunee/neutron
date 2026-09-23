## 2026-09-23 — Consume the durable panel identity in native Codex result transport

The original-request recovery requirement in
`docs/spec-items/trident-build-efficiency.md:154-166` applies to the result
transport as well as the review source. Full Open end-to-end verification found
that native Codex panel seats stopped before dispatch: their consumer still
accepted only the old six-character temporary directory names, while the durable
source now produces a lowercase 64-character SHA-256 identity.

The consumer now accepts exactly that canonical host-minted identity. It retains
the matching brief path, canonical result destination, run ownership, descriptor
and artifact validation. It does not add a legacy alternate path or loosen the
required-seat, synthesis or escalation gates (G057-G060 and G070-G073).

The focused result-transport suite passes 36 tests, including review and synthesis
positive controls and eleven malformed or foreign identity cases. All six native
Codex-owner consuming scenarios pass in
`open/__tests__/project-build-e2e.test.ts`: the valid case merges, while forbidden
edits, wrong schemas and lost or mismatched owner restoration remain refusals.
Broadening the identity alphabet makes uppercase and non-hex requests improperly
dispatch; narrowing the digest length makes the actual valid native panel fail.
Both semantic mutations are detected and restored. Combined typechecks, full
consuming verification and deployed live acceptance belong to the containing
efficiency integration; this isolated fix does not claim cutover.
