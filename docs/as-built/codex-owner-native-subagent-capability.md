## 2026-09-19 — Native subagent capability for the Codex owner factory

The locked harness plan requires same-provider bounded work to run as native
subagents of the project owner (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:96`).
The fresh owner factory now always supplies `features.multi_agent_v2=true` to
both its native app-server and remote TUI
(`runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts:69`).
This is required native configuration, not a selectable Neutron feature path.

The TUI's observed request uses nested `features: { multi_agent_v2: true }`.
Bootstrap accepts only that exact feature entry alongside the existing
personality and web-search fields. False, string values, additional features,
flat aliases and unrelated scope/provider overrides refuse
(`project-control-bootstrap-validation.ts:10`). Before sealing the binding,
the factory requests `experimentalFeature/list` for the exact native thread.
Missing, disabled, duplicated, unknown-stage, removed, deprecated or incomplete
feature evidence refuses (`project-control-bootstrap-validation.ts:16`). The
capability is immutable and explicitly labelled `native-thread-feature-report`
(`project-control-bootstrap.ts:163`, `project-control-bootstrap.ts:180`). It
attests support and enablement at bootstrap, not that a model has executed work.
No model turn is seeded to mint this binding.

The consuming smoke ran against native Codex 0.154.0 with a disposable project,
private home and loopback Responses provider. It observed the native
`collaboration.spawn_agent` advertisement, returned a function call through the
real protocol, and observed the native child provider request
(`project-control-bootstrap.smoke.ts:32`). The child's completed rollout proves
the exact parent thread, project cwd, provider and expected final answer
(`project-control-bootstrap.smoke.ts:118`). Zero provider requests before the
first owner message and existing forged/stale/scope controls remain checked
(`project-control-bootstrap.smoke.ts:80`). The provider supplies deterministic
responses: this proves native plumbing, not live-model judgement or production
readiness.

Validation: root and runtime TypeScript checks passed; 31 focused bootstrap,
broker and recovery tests passed; focused ESLint and diff whitespace checks
passed. Semantic mutations were exercised and restored: disabling the required
native feature made the consuming smoke fail at bootstrap, while accepting a
false feature value made the guard test fail. The restored native smoke and
focused tests passed. No production deployment or PR was performed. Shared
owner routing and build-dispatch policy are separate integration work.
The changed-file leak scan passed with the configured denylist. A full-tree
scan reported 465 findings across the checkout, including worktree Git metadata
and existing files; this change does not claim a clean whole-tree purity gate.
