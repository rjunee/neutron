## 2026-09-19 — Restricted native review and synthesis on the shared Codex owner

This slice consumes the native permission lease and private helper protocol for
same-provider review and synthesis. It implements the one-project REPL and
same-provider subagent requirements in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87-111`, without replacing
the host gates or publication path. The gate and unattended-build requirements
remain `docs/spec-items/the-orchestrator-owns-the-build-loop.md:56-66`; G063's
host-measured suite receipt and G071's no-progress stop remain unchanged
(`docs/trident-gates-inventory.md:137,150`).

### Built

`open/wiring/project-build.ts:262-276` preserves the registered result schemas
and requires the existing owner's restricted-review capability when a selected
panel or synthesis tier is Codex. The binding accepts only a guarded read-only
request and its exact host-derived project/run/step staging directory
(`open/wiring/codex-owner-binding.ts:519-538`). It uses the existing native owner,
not a second process or a headless same-provider fallback. The native lease
provides read access plus write access to that staging directory; no MCP or
prompt-only permission assertion substitutes for the native profile.

Permission preparation and native start retain a durable owner-work marker
(`open/wiring/codex-owner-binding.ts:123-148`). Concurrent review seats serialize
through the same owner. A stage receipt alone is insufficient: after the real
worker's registered schema validation and canonical publication, the guard
waits for the correlated parent and descendant tree to settle, restores the
profile, and awaits release acknowledgement before accepting the outcome
(`open/wiring/codex-owner-binding.ts:380-430`). Unknown preparation, settlement,
restoration, or acknowledgement fences the owner without replay. A lost helper
response can close live attestation; quarantine therefore uses cached,
previously attested facts solely to retain the durable marker at the exact
known owner home (`open/wiring/codex-owner-binding.ts:270-290`).

Only the authenticated typed native pre-reservation busy refusal is recoverable.
Likewise model controls catch only `ProjectControlAdmissionRefusal`; delivered
native errors and lost replies still fence
(`open/wiring/codex-owner-controls.ts:116-133`). The tests distinguish known
zero-mutation refusal from unknown mutation rather than matching error text.

Synthesis selection now admits Claude and Codex, while the runtime still
requires the structured verdict and isolated lease (`trident/phase-models.ts:271-279`).
Decomposition remains explicitly Claude-only. This supersedes the historical
Claude-only synthesis limitation recorded in
`docs/as-built/claude-cross-provider-headless.md`, not its cross-provider routing
or its immutable record. Unavailable isolation, unsupported synthesis providers,
and malformed schemas still refuse; there is no silent Claude fallback.

Actual native continuation exposed a top-level
`inter_agent_communication_metadata` record. The observer accepts only its
measured one-field payload, `trigger_turn: boolean`, as non-authoritative
scheduling metadata. It infers no thread, turn, input, or completion from that
record; unknown types and other shapes still refuse
(`runtime/adapters/codex-cli/persistent/rollout-observer.ts:222-232`).

### Evidence

- Full consuming `open/__tests__/project-build-e2e.test.ts`: 100 passed, 926
  assertions. Its six new restricted-owner cases use the real broker, private
  authenticated helper HTTP, and Open binding, with synthetic native effects.
  The valid case reaches unattended MERGED through Codex build, three review
  children, and Codex synthesis; only planning invokes the explicit Claude
  headless route. Forbidden repository edits, wrong schema, lost restore or
  acknowledgement, and mismatched restoration prevent merge.
- Focused binding, result transport, durable owner, observer, phase models, and
  producer parity: 193 passed, 1,111 assertions. Delayed child completion proves
  publication cannot release the lease early. Known busy and cold capability
  refusals preserve later chat; corrupt or foreign rollout identity, unknown
  preparation, and delivered model errors preserve durable refusal.
- Root and runtime TypeScript checks and scoped ESLint passed.
- Fifteen semantic mutations were killed, then restored: reject valid review;
  accept foreign staging; skip native settlement; accept lost restoration;
  poison clean review busy; poison clean model busy; waive delivered model
  errors; lose the closed-helper marker; poison cold capability refusal;
  accept corrupt rollout; remove measured native metadata support; accept
  arbitrary unknown metadata; remove Codex synthesis; admit unisolated review;
  admit an unsupported synthesis provider.
- A disposable actual native CLI 0.154 smoke completed owner chat, restricted
  child review, and next owner chat twice on one native owner. Children read
  canonical brief/context files outside the project and wrote only the staged
  result; the host validated and published canonical artifacts. An actual
  out-of-stage repository write was denied, its file remained absent, and the
  worker returned unknown. Removing the measured observer allowance made this
  actual continuation fail; restoring it returned the smoke to green.

### Boundaries

A separate actual cold-thread diagnostic returned native `thread/resume`
error `-32600` because no rollout yet existed. Restricted review now
capability-refuses before reservation only for the exact attested rollout's
absence (`open/wiring/codex-owner-binding.ts:347-360`). It does not fabricate a
snapshot or submit a seed turn. A subsequent ordinary owner turn creates the
rollout and permits the same review request; an existing corrupt or foreign
rollout still fences. Cold-first-review success is not claimed.

The MERGED proof is a consuming fixture, not a live unattended production merge.
Native smoke proves warm continuation and machine-enforced write isolation, not
all provider/network configurations. No deployment, served cutover, public push,
or completion of the entire governing spec is claimed. Disposable native smoke
scripts are excluded from this change. Privacy verification is scoped to this
change's additions and commit message; it does not certify the inherited tree.
