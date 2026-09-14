## 2026-09-14 — Issue 796: native-child authority feasibility stop

### Outcome and decision

Step 2 is **not implemented**. Stopped at the task's explicit feasibility condition:
“If you cannot enforce the parent/child grant distinction with the harness we have,
stop and say so.” This record documents the finding, not a shipped boundary.
Step 3 must remain blocked on the required enforcement proof.

The current receiving protocol cannot distinguish a project request from a worker
presenting the same project credential and request bytes. Its authentication
input is `X-Sink-Token`, resolved to a session at
`runtime/adapters/claude-code/persistent/pool-state.ts:522`; request `session_id`
is advisory at :545. The bridge supplies fixed session identity and arguments at
`runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:114`, with its fixed
credential at :173. Merely adding a role to this credential would authorize both
callers as the project. An optional caller-supplied child identifier would let the
worker omit it; requiring it without trusted provenance would let it copy the
parent value. Neither meets the specified adversarial boundary.

The missing prerequisite is a harness-authenticated per-call principal whose
parent authority cannot be replayed by native children, including their shell
access. This requires a verified harness/isolation capability before choosing the
boundary implementation. This finding is scoped to the checked-in adapter and its
receiving protocol; it does not assert that every possible harness lacks one.
No external harness investigation was attempted under the no-network instruction.

### Evidence and re-adoption

- `runtime/adapters/claude-code/persistent/spawn.ts:139` creates one generation for
  the REPL; :190 and :207 give both MCP bridges that generation's credential.
  `pool-state.ts:420` derives the credential from the generation.
- `runtime/adapters/claude-code/persistent/pool-state.ts:587` dispatches the request
  using the credential's project scope (:585), without a native-child principal.
- `runtime/adapters/claude-code/persistent/boot-adoption.ts:2408` reconstructs the
  session from the persisted generation; :2430 restores bridge attachment and
  :2749 registers the reconstructed session. Reconstructing the same grant does
  not introduce an authenticated native-child distinction.
- The exemplar at
  `runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts:317`
  reads the spawned credential; its denial control at :331 uses a DIFFERENT
  credential. That proves a different property than refusal of a worker holding
  its parent's credential. It was read before constructing the probe.

A scoped absence search was executed over the three receiving/forwarding files:

```sh
rg -n 'agent_id|agentId|parent_tool_use_id|SubagentStart|SubagentStop|SINK_TOKEN' runtime/adapters/claude-code/persistent/tools-bridge-impl.ts runtime/adapters/claude-code/persistent/dev-channel-impl.ts runtime/adapters/claude-code/persistent/pool-state.ts
```

Only the `SINK_TOKEN` positive-control arm matched: tools bridge :31, :52, :173;
dev channel :52, :67, :233, :235, :319. The claim is limited to those spellings
in those files, not a complete import graph or an inventory of harness features.
The fixed request construction and handler reads above are the stronger evidence.
The filed delivery citations were not used to infer runtime behavior; current
identity-path citations above were read directly in this session.

### Probe and limits

The initial real-HTTP attempt failed at `Bun.serve` with `EADDRINUSE`, including
an explicit loopback bind. It never reached authorization. The successful probe
instead invokes the real `ReplSink.handle` with real `Request` objects, bypassing
only listener creation. A stub dispatch records side effects; it does not send a
message to anyone. It models the receiving bytes of parent-credential replay,
not a live native agent, live owner chat, or full boot adoption.

Observed results, enumerated from the four requests in the probe:

| Request | HTTP status | Recorded dispatch |
| --- | --- | --- |
| Project parent | 200 | project-proof |
| Identical worker request with parent credential | 200 | project-proof |
| Wrong credential, same request | 401 | none |
| Same credential after reconstructed-session registration | 200 | project-proof |

All three successful calls reached the stub with the same tool, arguments, call
ID and project. The wrong-credential control reached the authorization refusal,
so the observation is not an unwired handler returning a constant success.
The worker-refusal acceptance criterion is RED conceptually (observed 200 rather
than refusal); no passing boundary test or live child isolation proof is claimed.

Reproduce by saving this temporary script at the repository root and running it
with Bun. Its exit status checks reproduction of the defect, not acceptance of a
fix. Delete the temporary script afterwards.

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplSink, replToolBridgeRef } from './runtime/adapters/claude-code/persistent/pool-state.ts'
import { ReplSession } from './runtime/adapters/claude-code/persistent/repl-session.ts'
const dir = mkdtempSync(join(tmpdir(), 'authority-probe-'))
const sink = new ReplSink()
const calls: unknown[] = []
replToolBridgeRef.current = {
  listToolSchemas: () => [],
  dispatch: async (input) => { calls.push(input); return { recorded: true } },
}
try {
 Object.assign(sink, { tokenPathValue: join(dir, 'sink-token') })
 const handle = (req: Request) => (sink as unknown as { handle(req: Request): Promise<Response> }).handle(req)
 const parent = new ReplSession('project-key', 'project-generation', 'project-session', 'channel', dir)
 parent.projectId = 'project-proof'
 parent.toolBridgeActive = true
 sink.register(parent.sessionId, parent)
 const token = sink.credentialFor(parent)
 const body = { session_id: parent.sessionId, tool_name: 'probe', args: { text: 'owner question' }, call_id: 'request' }
 const request = async (credential: string) => {
  const r = await handle(new Request('http://127.0.0.1/tool-call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credential }, body: JSON.stringify(body) }))
  return { status: r.status, body: await r.json() }
 }
 console.log('parent', JSON.stringify(await request(token)))
 console.log('identical worker request with parent credential', JSON.stringify(await request(token)))
 console.log('wrong credential', JSON.stringify(await request('invalid-credential')))
 sink.unregister(parent.sessionId)
 const adopted = new ReplSession('project-key', 'project-generation', 'project-session', 'channel', dir)
 adopted.projectId = 'project-proof'
 adopted.toolBridgeActive = true
 adopted.adopted = true
 sink.register(adopted.sessionId, adopted)
 console.log('after registration of reconstructed session', JSON.stringify(await request(token)))
 console.log('dispatches', JSON.stringify(calls))
 if (calls.length !== 3) throw new Error('Unexpected probe result')
} finally {
 sink.stop()
 replToolBridgeRef.current = undefined
 rmSync(dir, { recursive: true, force: true })
}
```

### Validation and mutation table

No guard or runtime outcome was introduced. Therefore there is no new outcome to
classify and no new invariant with a continuous maintainer. The missing continuous
maintainer is precisely the trusted per-call identity boundary described above.

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| None delivered; feasibility stop | Not applicable | No mutation certification claimed | No boundary GREEN claimed |

- Root typecheck: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — exit 0.
  Used the installed compiler directly; no dependency provisioning or network.
- `bun test trident/escalation-block.test.ts` — 29 pass, 0 fail, unchanged.
- `bun test trident/board-dispatch.test.ts trident/board-reconcile.test.ts` —
  87 pass, 0 fail, unchanged.
- No test file was added or edited, and no full-suite run was attempted.
- Record shape checked: exactly one `## ` heading. Only this record is staged.
  No runtime lint target was changed; no full purity certification is claimed.

### Deliberately unfinished

Every output family from the issue remains unclosed: native ask, returned
question, error text, arbiter OWNER_ONLY, raw sink HTTP, todo sync, registered
tool execution, app system notice, shell-mediated access and native-child replay.
This list is enumerated from the staged issue's Proof paragraph. Durable result
admission, passive-progress/terminal-status complements, owner-chat complements,
role grants after re-adoption, inventory ownership and sink-role mutation proofs
are also unfinished. No execution cutover, prompt restriction, tool-hiding guard,
second executor, or product/spec decision was added. This lane must not be used
to close issue 796 or authorize Step 3.
