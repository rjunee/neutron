---
title: Owner-installable MCP servers
group: platform
status: done
priority: P2
cutover: true
---

# Owner-installable MCP servers

## Acceptance

- [x] Saving a server definition does not authorize execution; an explicit decision is required.
- [x] Authorization is matched to the server name, executable, ordered arguments, and environment-variable names.
- [x] A stale or unreadable decision refuses execution, while changing only a secret value does not require a new decision.
- [x] Secret values remain in encrypted credential storage and never appear in status responses or decision prompts.
- [x] Only owner-facing conversational sessions receive approved servers; restricted and disposable sessions do not.
- [x] Removing, denying, or materially editing a server retires its authorization and warm process surface.

Verification: `bun test gateway/__tests__/mcp-servers-store.test.ts gateway/http/__tests__/app-mcp-servers-surface.test.ts runtime/__tests__/mcp-servers.test.ts gateway/__tests__/mcp-servers-client-parity.test.ts`.
