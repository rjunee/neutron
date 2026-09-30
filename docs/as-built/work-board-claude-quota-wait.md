## 2026-09-30 — Project durable Claude quota waits onto the Work Board

The Work Board previously derived phase/checkpoint progress without a quota
wait notice. The additive `quota_wait` projection now reads the host's current
pending step, its authenticated native child binding and the latest matching
quota state. Three run-indexed queries return at most three rows; unrelated
heartbeats and foreign child states cannot evict the selected evidence.
Terminal runs and settled or changed steps override earlier wait events.

HTTP and the existing push fan pass the bounded reader to the same projection.
Web and phone preserve the optional field, show explicit waiting and reset-time
copy, and clear it when a subsequent snapshot resumes. Known reset times use UTC;
unknown times say so. The phone notice wraps, and the waiting card suppresses a
duplicate start affordance without changing its in-progress lane or counters.

Validation: 238 projection/client/helper/HTTP/wiring tests, 51 web render tests
and 13 phone render tests passed. Trident and root TypeScript checks passed
using isolated workspace package links and the repository-compatible Zod 3
dependency; the shared dependency store was not changed. Two semantic mutations
failed their controls: returning no waits failed the positive wait test, and
ignoring resumed/end stage names failed the clearing test. Both were reverted.
The full project-build end-to-end
file is reserved for the integrated runtime/projection validation.
