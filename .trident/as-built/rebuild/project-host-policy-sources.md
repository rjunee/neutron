## WIRE5 — publication and leak source modules; review deferred

### Delivery boundary

This is a bounded partial delivery of two source modules. The review observation
adapter and launcher cutover remain future work. Publication exposes a scoped
callback carrying the existing publication option shape
(trident/project-publication-source.ts:12; trident/production-host-effects.ts:33).
Leak exposes an explicit GateResult operation (trident/project-leak-source.ts:10).
The current project host still accepts a scratch path and review source through
its policy options (trident/project-build-host.ts:33). Integrating the scoped
lifetime and leak operation into that composition remains necessary before a
production launcher can consume these modules. This record does not claim that
all three ProjectBuildHostOptions gaps are closed.

The scoped content search
`rg -n 'runProjectLeakSource|withProjectPublication|createProjectBuildHost' trident/project-build-host.ts trident/project-leak-source.ts trident/project-publication-source.ts`
found the source declarations at trident/project-leak-source.ts:10 and
trident/project-publication-source.ts:12, and the positive control
`createProjectBuildHost` at trident/project-build-host.ts:42. It found neither
new source name in that composition file. This is a working-tree content check,
not a claim about a fetched remote ref.

### Publication: real values and failure behavior

The old publisher asks GitHub CLI to fill from commits using `--fill`
(trident/orchestrator.ts:2736). That convention is not independent evidence of
what the worker accomplished. The durable row already contains the owner's
request in `task`, the slug, run identity and pinned launch base
(trident/store.ts:228; trident/store.ts:229; trident/store.ts:240;
trident/store.ts:249). The new title uses the first request line, bounded to 100
characters; the body includes the request and host run/base context
(trident/project-publication-source.ts:25). This is a deterministic formatting
choice, not an invented accomplishment summary.

Every invocation reads the host store and checks run/project/repository/branch/
worktree identity and terminal state before publication
(trident/project-publication-source.ts:17). Missing request, slug or full launch
base refuses preparation (trident/project-publication-source.ts:22). The host
writes a new mode-0600 body file before entering the callback, and awaits that
callback before cleanup (trident/project-publication-source.ts:28;
trident/project-policy-resources.ts:19). The caller must await publication inside
that callback; retaining only its body path past the callback is invalid.

Preparation, callback and cleanup failures produce `unknown` naming Publication
source (trident/project-publication-source.ts:31). The wrapper's `known` means
that it obtained the callback's value; it does not reinterpret that value as a
publication approval (trident/project-publication-source.ts:29). The existing
publication effects still independently assess the snapshot before pushing
(trident/production-host-effects.ts:328).

### Leak: allocation, reaping and uncertainty

Each invocation creates a unique host directory and uses its `tree` child for
the detached scan (trident/project-policy-resources.ts:18;
trident/project-leak-source.ts:18). The installation selects the trusted scanner,
not the project tree (trident/project-leak-source.ts:16;
trident/leak-preflight.ts:118). Missing repository/branch/full revision pins or
scanner return `unknown` (trident/project-leak-source.ts:12;
trident/project-leak-source.ts:17).

The existing sentinel classifier rejects empty output
(trident/leak-preflight.ts:206). The source additionally rejects timeouts and
contradictory exit-zero responses before classification
(trident/project-leak-source.ts:21). Clean becomes `allow`; recorded findings
become `blocked`; all remaining preflight statuses become `unknown`, including
missing project scanner, incomplete coverage and gate errors
(trident/project-leak-source.ts:25). These join the existing GateResult vocabulary
(trident/build-run.ts:34), whose gate-stop consumer preserves blocked and unknown
instead of continuing (trident/build-run.ts:168). This source must be integrated
as that kind of gate; merely allocating a path for the advisory preflight would
not deliver its refusal semantics.

Cleanup runs in a host `finally`, including when the callback throws
(trident/project-policy-resources.ts:20). Before every allocation, the host scans
its resource root and reaps directories whose recorded process owner is dead;
uncertain ownership fails the operation, and live owners are retained
(trident/project-policy-resources.ts:9). This does not depend on worker output or
worker cleanup. A subsequent host invocation can reap a dead predecessor.

Limits: the root must be host-owned, outside worker writable roots. Reaping is
on entry, not a periodic service; a reused process id is retained conservatively
(trident/project-policy-resources.ts:4). This does not claim immediate cleanup
after host death, process-group supervision, or integration with a fleet reaper.
A failed git-worktree removal can leave registration metadata; the retained
preflight prunes registrations before its next add (trident/leak-preflight.ts:270).
The outer resource cleanup removes the remaining materialised files independently
(trident/project-policy-resources.ts:20).

### Review: precise remaining work

Reuse the configuration parser that reads `NEUTRON_REVIEW_SEATS`, refusing bad
rows by model name (runtime/configured-models.ts:10;
runtime/configured-models.ts:20). The existing descriptor adapter maps that data
into the model-tier vocabulary (trident/model-tiers.ts:229). That adapter uses
process environment; a future project composition must supply the applicable
project configuration, rather than treating an ambient default as project policy
(trident/model-tiers.ts:230).

Still required: configured ReviewSeat role/enabled mapping, authoritative
run/head/round/provider/model-bound seat observations, a bounded dispatch retry,
and authoritative synthesis/checkpoint reads. These are the enumerated members
of ReviewSource (trident/gates/review-panel.ts:27). Preserve the panel's missing
observation, unavailable/deferred/rate-limited status, unusable verdict and
synthesis provenance distinctions (trident/gates/review-panel.ts:83;
trident/gates/review-panel.ts:85; trident/gates/review-panel.ts:87;
trident/gates/review-panel.ts:91). Its infrastructure refusal is currently
`blocked` with an `infra-only` name (trident/gates/review-panel.ts:39); do not
silently claim that this existing path returns `unknown`. No review adapter or
review mutation is claimed in this partial delivery.

### Validation and mutation evidence

The terminal-state fixture initially used an invalid phase, `merged`. It was
corrected to `done`, matching the existing terminal vocabulary
(trident/state-machine.ts:48). The refusal assertion was preserved
(trident/project-policy-sources.test.ts:39).

Each mutation below was applied independently, its landed line printed, compiled
with `bun x tsc --noEmit -p trident/tsconfig.json`, and exercised with
`bun test trident/project-policy-sources.test.ts`. RED means a wrong runtime
answer or retained/deleted materialisation, not a parser/type failure. Every
restoration reran that test file GREEN.

| Guard and printed landed line | Compiling mutation | RED test evidence | Restored |
| --- | --- | --- | --- |
| Publication identity, trident/project-publication-source.ts:18 | `if (!row)` | Changed identity reaches publication, test:39 | GREEN |
| Required metadata, trident/project-publication-source.ts:22 | `if (false)` | Missing task/base reaches publication, test:39 | GREEN |
| Final cleanup, trident/project-policy-resources.ts:20 | Empty finally | Body/materialisations remain, test:26 and test:50 | GREEN |
| Dead-owner reaping, trident/project-policy-resources.ts:15 | `await Promise.resolve()` | Dead directory remains, test:60 | GREEN |
| Unreadable ownership, trident/project-policy-resources.ts:14 | `if (false) throw error` | Existing materialisation deleted, test:120 | GREEN |
| Trusted scanner, trident/project-leak-source.ts:17 | Return `allow` when missing | Missing installation accepted, test:112 | GREEN |
| Revision/source pins, trident/project-leak-source.ts:13 | Return `allow` when missing | Missing pins accepted, test:135 | GREEN |
| Empty/incomplete fallback, trident/project-leak-source.ts:27 | Return `allow` | Empty and incomplete scans accepted, test:80 | GREEN |
| Findings, trident/project-leak-source.ts:26 | Return `allow` | Recorded findings accepted, test:80 | GREEN |
| Timeout/result consistency, trident/project-leak-source.ts:21 | `if (false)` | Timed-out scanner accepted, test:143 | GREEN |

Here `test:N` abbreviates trident/project-policy-sources.test.ts:N.
The scanner mutation was rerun after the mutation runner restored an older copy
of the file over the concurrent timeout fix. The new timeout test caught that
lost edit; the fix was reapplied before the successful final mutation sequence.

Final validation:

- `bun test trident/project-policy-sources.test.ts trident/project-build-host.test.ts trident/production-host-effects.test.ts`: 80 passed, zero failed, 346 assertions.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed.
- Final source typecheck: `bun x tsc --noEmit -p trident/tsconfig.json`.
- `bash scripts/ci/lint.sh`: passed.
- `git diff --check`: passed. Exactly one `## ` heading in this record.

The full matrix ran before the final timeout normalization; the final source
check covers that last edit. The bounded test files above are the complete test
run list, enumerated from the invoked command, not a whole-directory sweep.

### Deliberately outside this change

Review sources, in-REPL runners, launcher wiring, spec decisions, and replacement
of the old publication path are outside this partial delivery. The change adds
standalone modules; it does not claim a production caller or a completed launcher
cutover. The existing inventory was reused rather than rebuilt.
