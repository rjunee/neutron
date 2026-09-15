---
title: Resolve the model provider per instance and project
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#869"
---

Within the harness hierarchy, the most specific explicit choice wins: project override, instance default,
application default (Claude Code). A null project override follows live instance
changes; an explicit Claude Code choice does not. Resolution includes its source.
An unwired selection refuses visibly instead of falling back to another provider.
An explicit [configured API project route](configured-models-for-review-and-chat.md)
selects the conversational model before this hierarchy (Decisions Log 2026-09-15,
configured model access); the provider settings continue to describe the harness.

### Configuration

After migrating the instance database, provisioning and live updates use:

```sh
bun open/instance-model-provider.ts <database> <instance> openai-codex
bun open/instance-model-provider.ts <database> <instance> inherit
```

The former environment setting is imported once on first boot after migration.
An explicit stored choice, including inheritance, survives subsequent restarts.
The existing project settings PATCH sets `model_provider`; null clears the override.
Credentials still need to be configured for the selected adapter.

### Acceptance

- [x] Separate instance databases accept independent defaults, including Codex.
  Verify: `open/__tests__/instance-model-provider.test.ts`.
- [x] Unset projects follow a live instance change; explicit projects retain their choice.
  Verify: `open/__tests__/instance-model-provider.test.ts`.
- [x] Dispatch with a project ID resolves that project's provider independently of
  the active chat fallback. Verify:
  `gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`.
- [x] The project settings inspection exposes the resolved provider and source.
  Verify: `gateway/__tests__/app-projects-surface.test.ts`.
- [x] Build substrate dispatch reaches Codex without a Claude dispatch, paired with
  a positive Claude control. Verify: `open/__tests__/open-wiring-substrates.test.ts`.
- [x] Unwired selections name the requesting level.
  Verify: `gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`.
- [ ] A Codex project orchestrates an actual build through completion on Codex.
  Depends on [the project REPL orchestration change](the-orchestrator-owns-the-build-loop.md)
  (#545). Substrate selection alone does not replace the native Workflow launcher.
