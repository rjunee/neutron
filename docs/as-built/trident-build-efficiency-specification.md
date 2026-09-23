## 2026-09-23 — Specify Trident efficiency as a cutover blocker

Promoted #1196's investigated scope into
`docs/spec-items/trident-build-efficiency.md` and regenerated the spec index.
The criteria cover attributable failed-attempt usage, concurrent independent
reviews, provider-correct placement and thread continuity, evidence-bound recovery,
and deterministic plus deployed measurements. Unknown token data cannot establish
a saving. No runtime optimization ships in this documentation change and the
P0 item remains open.

The source measurement is pinned to `7d5ca4bd`: sequential seat reads at
`trident/gates/review-panel.ts:86-87` dispatch lazily through
`trident/project-review-source.ts:193-197`; build usage collection follows the
early failure returns at `trident/build-run.ts:372-395`. Existing same-head reuse
at `trident/build-run.ts:303-313` prevents treating every retry as a fresh build.

Corrected the orchestrator item's deletion criterion to follow the owner-directed
repair-in-place decision in `SPEC.md:323-331`. The checkpoint item's correction
and completion already shipped in #1195 and are preserved unchanged on this
branch. This specification does not change either item's completion status.
No immutable Decisions Log entry or prior as-built record was changed.

Validation: the generated-index tests and documentation guards check this
specification change; implementation tests and live efficiency proof remain
requirements on the implementing PRs, not results of this specification PR.
