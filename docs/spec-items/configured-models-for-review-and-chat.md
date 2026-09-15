---
title: Configure models once for review and project chat
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#939"
---

A configured model is a row with a tier, provider label, exact model ID,
chat-completions endpoint, and environment credential reference. Review and
project chat use the same row. Adding a provider must not require a new union
member. See Decisions Log 2026-09-15, configured model access.

### Configuration

`NEUTRON_REVIEW_SEATS` retains its existing name and contains JSON rows:

```json
[{"tier":"glm","provider":"zai","model":"EXACT_MODEL_ID","endpoint":"EXACT_CHAT_COMPLETIONS_URL","credential":"GLM_API_KEY"}]
```

Replace the model and endpoint placeholders with the values supplied by the
provider or compatible router. Set the referenced credential separately.
`NEUTRON_PROJECT_MODELS` maps project IDs to tiers, for example
`{"project-id":"glm"}`. This is an explicit conversational route: it takes
precedence over that project's inherited harness selection. Removing the mapping
returns chat to the ordinary provider hierarchy. Project settings' provider field
continues to configure the harness; it does not edit this map. Configuration is
supplied to the Open process and reread at dispatch
(`runtime/configured-models.ts:10`, `runtime/configured-models.ts:41`).

Each selected tier must refuse by name when its row, credential, or provider
response is unavailable or unrecognised. A router must return the exact requested
model ID, including on streamed chunks. Aliases that resolve to a different ID
are refused. Configure the concrete ID instead.

### Acceptance

- [x] The same row drives the review CLI and direct chat without a provider enum
  edit. Verify: `trident/__tests__/api-review.test.ts` and
  `runtime/adapters/configured-chat/index.test.ts`.
- [x] Two project IDs route to distinct configured models without either built-in
  provider key. Tool manifests retain their existing trust scope and tools bind
  to the calling project. Verify: `open/__tests__/open-wiring-substrates.test.ts`.
- [x] Chat handles streamed text, tool results, cancellation, malformed streams,
  missing credentials and wrong model attribution. Verify:
  `runtime/adapters/configured-chat/index.test.ts`.
- [x] Stateless live chat rehydrates its existing recent-history/context block on
  every turn; overlapping input queues; failures name the tier in the chat bubble.
  Verify: `gateway/wiring/__tests__/build-live-agent-turn-context-reset.test.ts`.
- [ ] Measure live Kimi, GLM and DeepSeek endpoints and router support for
  streaming, tool calls and exact model attribution with supplied credentials.
- [ ] Evaluate the suggested codex-router candidate, including interactive and
  headless execution. Fixture tests do not establish third-party compatibility.

### Scope

This change uses the chat-completions API protocol already used by configured
review seats (`trident/api-review.ts:24`). It does not integrate a new harness,
install a router, add a model picker, or alter build orchestration. The external
measurements remain open; this item must not be marked fully verified from
fixture evidence alone.
