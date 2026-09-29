---
title: Fence Claude tool admission and account for accepted calls durably
group: platform
status: open
priority: P0
cutover: true
issue: 1416
---

## Boundary

The existing tool handler contract returns `Promise<unknown>`; it does not
attest that downstream effects have ended (`tools/registry.ts`, `ToolHandler`).
A tool can return a durable workflow identity while that workflow continues
(`trident/work-board-build-tool.ts`, `work_board_start`). A journal of handler
returns therefore cannot, by itself, certify that generation-owned effects are
drained. This foundation proves only accepted MCP handler completion. Its
read-only result is named `mcp-handlers-drained` and always retains
`downstreamEffects: unknown`. Effect settlement and authoritative transfer to
another durable owner require additional evidence; neither may be inferred
from a successful generic return value.

## Governing constraints

The locked [orchestrator pivot](../plans/harness-orchestrator-pivot-2026-09-11.md)
§3.2 keeps same-provider work inside native subagents; its preserved-gates section
does not permit recovery to bypass review or merge controls. The
[restart contract](a-gateway-restart-keeps-the-project-repls.md), “RETRY AND
FENCING” and “WORKFLOW CONTINUITY”, requires exact-scope fencing, completed-work
harvest and at-most-one workflow dispatch. Neither requires an immortal native
child identity.

This foundation does not authorize lease release, parent or child termination,
replacement, credential rotation, or automatic continuation. A tool-admission
fence is not a process fence or proof that native shell/file effects ended.

## Acceptance

- [ ] Every accepted Claude MCP invocation is bound by authenticated host state
      to its parent session, parent generation, project and admission generation;
      model-provided fields cannot select another identity.
      Canonical General (`null`) and a project literally named `general` remain
      distinct through spawn, adoption, admission, dispatch and closure. An
      ambiguous legacy pool label without explicit scope refuses admission.
- [ ] Generation closure and call admission serialize at the durable authority.
      A request authenticated before an asynchronous body read but admitted after
      closure is refused. An open, authorized generation still executes a valid
      call; a refuse-everything implementation fails acceptance.
- [ ] Distinct invocations of the same tool have distinct identities. A duplicate
      accepted identity cannot execute again; conflicting arguments refuse.
      The bridge does not automatically retry a failed transport. A repeated
      accepted invocation ID never becomes a new attempt after restart.
- [ ] Durable acceptance precedes handler execution. Missing outcome after a
      crash, persistence failure, or ambiguous handler result
      remains unknown and cannot be interpreted as a successful drain.
- [ ] The read-only exact-generation proof distinguishes a closed, affirmatively
      handler-complete generation from unknown. An adopted generation with no
      previous coverage ledger remains unknown even after its observed calls
      return. Proof waits for the database mutex and reads a committed snapshot;
      a concurrently held settlement that rolls back cannot transiently certify
      drain, while a successful commit permits it. A proof requested inside a
      caller's uncommitted transaction remains unknown. Downstream effects remain
      unknown in all cases.
- [ ] Both-direction tests cover authorized execution and closure/refusal,
      delayed-body revocation, duplicate/conflicting calls, crash gaps, persistence
      failure and generation isolation. Consuming coverage in
      `open/__tests__/project-build-e2e.test.ts` must not treat this foundation as
      permission to release a native lease or dispatch a replacement. Both root
      and Trident TypeScript checks pass for an implemented slice.

Local unregister/ownership loss is not durable generation closure. A surviving
parent can be adopted with its original identity and existing coverage. Exact
closure is a separate host operation; this foundation does not add a maintenance
or recovery endpoint that exercises it.

Already-running legacy bridges that emit `session:tool` instead of unique call
identities cannot satisfy this contract. They fail closed; this change does not
claim to hot-reload them or authorize restarting their parent. A supported bridge
reconnection is a deployment prerequisite for those survivors.

Prospective containment also needs pending credential activation, placement
attestation and an execution acknowledgment. Current spawn registration alone
does not provide that handshake; this item does not claim to deliver it.
