## 2026-09-19 — Draft shared Codex owner binding for chat and build

This is an integration draft, not cutover or restart acceptance. It consumes the
frozen broker, native rollout observer and fresh-owner factory without changing
their implementations. The governing target remains the project conversation
and build sharing one REPL (pivot plan §3.1–3.2).

`open/wiring/codex-owner-binding.ts:21` owns one memoized opening per full
project id. It verifies the project-home marker, reads the factory's opaque
native authority, and shares an exclusive native-turn lease between owner chat
and build dispatch. A failed opening or uncertain delivery is fenced rather
than retried as a fresh owner. No model turn is used to seed a thread.

`open/composer.ts:1086` constructs the resolver once and supplies it to both
consumers. `gateway/wiring/build-llm-call-substrate.ts:969` routes owner Codex
chat through it before configured API tiers. Missing wiring refuses explicitly.
`open/wiring/project-build.ts:273` uses that same resolver, replacing the
separate build-session constructor and topic-derived thread. The acting bridge
receives the attested native thread at
`open/wiring/codex-owner-binding.ts:195`. Existing Claude and non-owner bounded
worker routes remain covered by the regression suite.

Evidence:

- Eight consumer tests cover chat/chat/build/chat continuity, a separate project,
  native-thread versus topic identity, configured-tier precedence, missing
  wiring, recovery refusal, uncertain receipts, approvals, foreign home markers
  forged authority and a missing child trailer fencing subsequent chat after the
  native parent completed. A true/false native capability test admits the attested
  fixture and refuses missing capability. The transport is a fixture; the observer and consumers
  are real.
- The manual `open/wiring/codex-owner-binding.smoke.ts` passed against native
  Codex with a loopback model fixture: four actual chat turns, one factory launch
  per project, identical first-project thread across a refused build, distinct
  second-project thread, and prior chat text in the next native request.
  Its final build refusal is intentional: the frozen factory does not attest
  subagent capability. Before that guard was added, a five-turn smoke proved
  native build-dispatch continuity, but did not prove that a child was spawned.
- The focused five-file suite passed 225 tests, including
  `open/__tests__/project-build-e2e.test.ts` admission, review, publication and
  merge regressions. That E2E harness remains primarily a Claude build harness;
  it is not evidence of an unattended native Codex build reaching merge.
  After adding the cross-consumer child uncertainty fence, all eight consumer
  regressions were rerun and passed.
- Root and Open TypeScript checks and lint on changed TypeScript files passed.
- The actual-denylist scan of the staged added lines passed with zero findings.
  The complete-tree privacy scan failed with 454 findings; this draft does not
  claim the complete tree is privacy-clean and does not modify the gate.
- Semantic mutations replacing native thread with topic, bypassing owner
  dispatch, bypassing native capability, bypassing the child uncertainty fence
  and bypassing the full project-home marker each failed the consumer
  tests. Restoring the implementation passed the consumer tests.

Cutover remains blocked. The factory owns its native app-server, authenticated
TUI connection and PTY inside the gateway process and refuses a prior sealed
namespace. The missing recovery contract is a surviving host-owned native
process/broker plus attested attachment to the same thread, credential
fingerprint and binding generation, including reconciliation of pending turns.
Neither replay nor a fresh-owner fallback is supplied here.

The frozen factory's default native model request did not advertise
`spawn_agent`. Asking it to enable `features.multi_agent_v2=true` failed its
bootstrap config allowlist. Build dispatch therefore requires affirmative
`capabilities.multiAgentV2` from the host's opaque binding facts
(`open/wiring/codex-owner-binding.ts:163`); this factory version supplies no such
attestation and build dispatch refuses. Native feature support/enablement and a
separate real-child consuming proof belong to the factory capability follow-up.

General chat and global rotating credential homes are refused: this slice
requires a selected project and its full-id-marked credential home. Native
approval requests fence the turn until an owner response surface is implemented
(`open/wiring/codex-owner-binding.ts:44`). Model current/list/switch stays on the
existing unsupported Codex surface; this slice does not claim §3.6 acceptance.
Native Neutron MCP/tool and prompt-policy integration also remains outside this
binding-continuity proof. No cutover spec acceptance box is changed.
