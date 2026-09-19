## 2026-09-19 — independent review findings can reach synthesis without identical prose

### Failure and cause

In a live Trident build, the independent top review returned findings that differed from the later panel synthesis. The review gate treated that difference as a failure because it compared the worker trailer with the recorded synthesis field-for-field, including finding titles and evidence. The run ended at review; no fix round ran. The two outputs serve different jobs: the top review supplies an independent veto, while synthesis combines the panel's findings. Requiring their prose and finding lists to be identical made valid independent review impossible to pass.

### Change

The review gate no longer requires the independent review trailer to repeat the synthesis verbatim. Every valid review result still participates in the veto: a credible blocker cannot be cleared by a more favorable synthesis. The change retains the configured-seat completeness checks, run/revision/round/provider/model provenance, trailer schema validation, and synthesis validation. It removes only the equality requirement between distinct review products; malformed or missing evidence is not promoted to approval.

This is a gate repair, not a relaxation of the product's review requirement. The locked pivot requires keeping the cross-model gate and arbiter rule (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265-268`), and the build-loop spec requires every existing gate to remain enforced (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56-59`).

### Outcome and limits

The observed run is evidence of the original stop, not evidence that the repair is served or that a card reaches merge. Verification results belong to the code change's review and must be recorded from completed checks; no live success is claimed here.
