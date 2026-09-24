## 2026-09-24 — General Codex owner scope and credential admission

General now reaches the durable Codex conversation owner with an explicit null
scope. Conversation leases, native model/approval controls, rollout observation,
installed MCP and helper admission preserve that scope separately from a project
named `general`. Open composition supplies the selected global credential home
and General's owner directory; project owners retain their explicit project
credential grants and complete project markers.

`CodexCredentialService.resolveGeneralOwnerCredential` reads the selected global
seat in place without reviewer rotation or credential copying. Missing, expired,
revoked, mixed-auth or mismatched account credentials refuse. Native token refresh
retains the stable account identity. `openDurableCodexOwner` reserves a fixed
instance authority journal before launch, binding null scope, cwd, credential home
and account identity. Selecting another home or account after gateway restart
requires reconciliation rather than creating a second General owner.

Validation: 156 focused owner, credential, consuming substrate, helper, native
HTTP-control and installed-MCP tests passed, plus 12 consuming Codex owner/MCP
project-build E2E cases. Root, Open and Trident TypeScript checks passed. Four
restored semantic mutations failed as intended: unconditional General refusal,
aliasing General to project `general`, accepting a project credential marker for
General, and bypassing the fixed authority journal. Independent security review
found selected-seat fallback and cross-home restart gaps; both were corrected and
the second review cleared the code.

This change does not complete project workspace placement or sleep lifecycle.
No live credentials were provisioned, copied or changed, and no live native
provider launch or deployment was used as evidence. Those consuming placement
and lifecycle criteria remain open in `project-herdr-workspaces.md`.
