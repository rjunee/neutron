## 2026-09-14 — Registry resume audit addition (#676)

| Consumer | Unknown must not mean absent | Test |
| --- | --- | --- |
| `runtime/adapters/claude-code/persistent/spawn.ts:924` — `resolveResumeDirective` | Unreadable registry or invalid target row refuses retryably; ENOENT and absent row permit fresh spawn | `runtime/adapters/claude-code/persistent/__tests__/registry-resume.test.ts:10`; integration at `runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts:1342` |

The build-lane [record](../../.trident/as-built/fix/676-unreadable-registry-is-not-empty.md)
contains the decisions and the mutation results. This is an audit addition for the
named consumer, not a claim to enumerate every registry reader.

CORRECTION: that record also described a local socket restriction as preventing
integration acceptance. It does not. Run in a socket-capable runner,
`runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts` is
37 pass / 0 fail on the commit that shipped this, so the integration cell above
is MET, not pending.
