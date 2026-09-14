## 2026-09-14 — Registry resume audit addition (#676)

| Consumer | Unknown must not mean absent | Test |
| --- | --- | --- |
| `runtime/adapters/claude-code/persistent/spawn.ts:924` — `resolveResumeDirective` | Unreadable registry or invalid target row refuses retryably; ENOENT and absent row permit fresh spawn | `runtime/adapters/claude-code/persistent/__tests__/registry-resume.test.ts:10`; integration at `runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts:1342` |

The build-lane [record](../../.trident/as-built/fix/676-unreadable-registry-is-not-empty.md)
contains decisions, mutation results, and the local socket restriction preventing
integration acceptance. This is an audit addition for the named consumer, not a
claim to enumerate every registry reader.
