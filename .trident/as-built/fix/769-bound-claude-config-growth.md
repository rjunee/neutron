## 2026-09-14 — Bound newly seeded Claude project trust growth (#769)

### Measurement before editing

Read the live default config without writing it: 2,360,479 bytes and 19,535
projects. Bun parse plus pretty stringify, five warmups and thirty measured
samples: minimum 13.17 ms, median 15.35 ms, maximum 24.65 ms. This is a modest
per-spawn cost; this change targets retention, without claiming a launch speedup.
The filed line references were accurate before editing: the read and replacement
were at `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:81` and
`:100`; the call remains `runtime/adapters/claude-code/persistent/spawn.ts:332`.

### Policy and implementation

The live-config path census contradicts a worktree-only attribution: 49 keys
are immediate children of `.trident-worktrees`, while 19,473 are immediate
children of the temporary directory. Of those, 19,471 match four test-directory
prefixes. Matching creation sites include
`runtime/adapters/claude-code/__tests__/unconditional-persistent.test.ts:54`,
`tests/support/test-isolation.ts:116`, `open/__tests__/open-wiring-app-ws.test.ts:66`
and `open/__tests__/usage-dashboard-unreadable-wiring.test.ts:68`. Counts were
enumerated across every project key, grouped by parent and basename prefix.

The seeder records `neutronSeededProjectParentV1` only when it creates a new
project entry for a live directory
(`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:129,137`). Existing
entries are not adopted. The marker contains the immediate parent's device,
inode and birth time (:72). It is private seeder metadata, not a claimed Claude
schema field. Ownership is recorded at creation rather than inferred from a
path prefix, covering both future test directories and disposable worktrees.

Every subsequent seed sweeps within the existing sidecar lock (:108,128).
Removal requires a recorded string marker, child lstat returning ENOENT, and a
currently accessible parent with the recorded identity (:78). A live child,
including an empty mount-point directory, survives; lstat preserves dangling
symlinks. An unavailable, symlinked or replaced parent cannot prove deletion.
Unknown filesystem errors preserve the entry. Bidirectional tests seed elsewhere
so a lost live entry cannot be concealed by re-creation
(`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts:102`).

Maintenance runs on later spawns without requiring the departed worker or its
teardown to succeed. The bound is conditional: recorded deleted children of
available, unchanged parents are reclaimed on the next seed. Live entries,
uncertain entries and unrecorded history remain. Filesystem probes are
observations, not a lock against external filesystem changes; the existing
writer lock serializes Neutron config writers, not directory creation/removal.

Malformed or unreadable config now refuses instead of replacing it with an
empty object (`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:114,118`).
These errors join the existing `spawn_configuration` vocabulary through
`SpawnConfigurationError` (`runtime/adapters/claude-code/persistent/spawn-configuration-error.ts:4`),
validated by `classify-spawn-error.ts:99`. The explicit taxonomy default is
non-retryable (`runtime/errors.ts:106`), not a credential/provider failure.

The writer retains the existing merge and atomic rename
(`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:130,144`). On a
private temporary copy of the live config, enumerated every original project
key and every top-level key: all 19,535 projects and all 63 top-level values
survived unchanged. The destination inode changed; the original config bytes
were unchanged. One full copied seed of the final implementation took 60.76 ms including lock and write.
Fixture preservation also covers nested custom project and global values
(`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts:105`).

### Mutation evidence

Each row was applied alone to `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts`;
the actual mutated line was printed before running the focused test file.
Each mutation exited nonzero; restoring it returned all 16 tests to GREEN.
Fault fixtures assert the child probe was reached before accepting preservation
(`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts:222`).

| Guard / behavior | Mutation and source line | RED evidence | Restored |
| --- | --- | --- | --- |
| Sweep | Omit call, :128 | Deleted entry survives | GREEN |
| Current project | Remove exclusion, :80 | Custom current state lost | GREEN |
| Ownership | Remove newly-seeded restriction, :137 | Existing project adopted | GREEN |
| Recorded marker | Bypass string check, :82 | Unrecorded unavailable history lost | GREEN |
| Live child | Replace lstat with ENOENT, :85 | Live project lost | GREEN |
| Known absence | Replace ENOENT test with true, :88 | EACCES entry lost | GREEN |
| Parent still available | Remove identity check, :89 | Changed / disappeared-parent entry lost | GREEN |
| Live stamp | Replace directory probe with true, :139 | Missing/file cwd gets marker | GREEN |
| Record provenance | Assign undefined marker, :139 | Deleted entry survives | GREEN |
| Read refusal | Restore empty-object fallback, :114 | Malformed bytes replaced | GREEN |
| Shape refusal | Omit throw, :122 | Invalid config not classified/preserved | GREEN |
| Replacement | Omit rename, :147 | Seed/removal not persisted | GREEN |
| Atomic write | Replace rename with in-place write, :147 | Inode preservation assertion fails | GREEN |
| Parent symlink | Use stat instead of lstat, :70 | Symlink parent authorizes removal | GREEN |

An initial duplicate parent-identity precheck survived mutation because the
post-ENOENT identity check still refused deletion. The mutation landed correctly;
the latter check made the former redundant. Removed the redundant precheck,
kept the post-ENOENT proof, and re-ran the entire mutation table against the
final code. No assertion was weakened. The recorded-marker fixture includes
unmarked history with an unavailable parent to exercise the undefined-identity
hazard (`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts:127`).

### Validation

- `bun test runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts`: 16 passed, 46 assertions.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed. After the final scope correction, both `bunx tsc --noEmit -p runtime/tsconfig.json` and `bunx tsc --noEmit -p tsconfig.json` passed again.
- `bash scripts/ci/lint.sh`: passed, including a full refresh after the final scope correction.
- `bash scripts/ci/leak-gate.sh --tree .`: INCOMPLETE, exit 3. Zero findings from rules that ran; PII file/message rules require the unavailable denylist. This is not a clean certification.
- `git diff --check`: passed.

### Deliberate limits and decisions

Historical entries without provenance are deliberately preserved; this is not a
retroactive purge of the 19,535-entry backlog. A path prefix and current absence
do not prove historical ownership or mount identity. Parent replacement, metadata
loss, and inaccessible parents can leave retained entries. If Claude removes the
custom marker, pruning safely stops for those entries; compatibility with
Claude's internal compaction has not been established. No live Claude binary
was launched for this investigation.

No config-directory isolation or credential migration: the existing default
shares the local login (`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:26`).
No TTL, size cap that evicts live projects, worker teardown dependency, feature
flag, or new outcome class. No product-level spec decision changed. The full
test suite was not run, per the build-lane instruction. The as-built staging
location here follows the task-specific instruction overriding the general
`docs/as-built/` location. Local commit only; publication belongs to review.
