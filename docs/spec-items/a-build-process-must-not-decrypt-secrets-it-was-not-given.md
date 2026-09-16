---
title: Scope build credential reads to the bound project
group: security
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

## Decision and boundary

Owner decision, 2026-09-16: accept the reach, narrow the blast radius. See
`SPEC.md` Decisions Log 2026-09-16, API credential scoping (#515). Same-model
bounded work stays inside the REPL process. API scoping prevents incidental
cross-project access; it does not prevent deliberate reads of the shared key.
The former requirement to prove that a build cannot decrypt an unassigned secret
is superseded, not achieved. The earlier agent-side push issue was already
resolved separately; this change does not alter publishing.

## Measured storage and read path

`secrets` uses `(owner_handle, kind, label)`; its historical SQL column
`project_slug` contains the owner handle, not the real project id
(`auth/secrets-store.ts:17`, `auth/secrets-store.ts:230`).
`project_credentials` already has `(owner_slug, project_id, service)` as its
unique key (`project-credentials/store.ts:266`). Its empty project id denotes an
explicit global row (`project-credentials/store.ts:35`). Both stores share the
AES key (`auth/secrets-store.ts:79`). This requires read-path scoping, not a
migration or re-encryption.

The normal Core tool read path binds project identity at MCP dispatch
(`mcp/server.ts:150`, `gateway/composition/build-core-modules.ts:368`). The
resolver refuses unknown identity and a conflicting requested project before
reading the credential sources (`gateway/cores/core-credential-resolver.ts:282`).
A trusted host call outside a dispatch must supply a project explicitly. This
also means General-topic or cron Core reads without a project refuse; missing
context is not authorization for a global default.

## Explicit instance-wide exceptions

These are the existing policies, not inferred access to every project:

- Rows deliberately saved with `scope: 'global'` are shared defaults for their
  named service; the owner enumerates these through Settings. The write maps that
  scope to the empty project id and the resolver reads only that exact sentinel
  (`project-credentials/store.ts:218`, `project-credentials/store.ts:334`). This
  applies to custom service names as well as built-in ones.
- `gmail_compose` and `google_calendar` force global scope. Legacy OAuth grants
  for those two services and `google_workspace` are shared fallback grants. The
  exhaustive built-in Core policy is `SERVICE_SCOPE` plus `GOOGLE_OAUTH_LABELS`
  (`gateway/cores/core-credential-resolver.ts:66`). Project account selection
  still narrows those grants (`gateway/cores/core-credential-resolver.ts:222`).
- The host's GitHub credential is the instance `oauth_token` / `github` secret
  (`github/credential.ts:50`, `github/credential.ts:79`). Codex shared seats use
  `codex` / `codex-acct-<slot>` global rows (`trident/codex-credential.ts:55`,
  `trident/codex-credential.ts:68`, `trident/codex-credential.ts:1179`); Kimi uses
  its host lookup (`open/composer.ts:3934`). These host authentication paths are
  outside the Core credential API and remain instance-wide. This is not a claim
  that every host-side secret reader is project-bound.

Unknown project context refuses even the Core exceptions. Direct host store
access, rebinding process context, and direct key/database reads remain possible
for code in the shared process; this is not a hostile-code isolation boundary.

## Acceptance

- [x] A tool call bound to A can read A's credential, cannot read a B-only
  credential, and refuses an explicit request to override its binding with B.
- [x] Unknown context (missing, null, empty or whitespace) refuses, including
  global rows and OAuth fallback; a request parameter cannot fill in a bound
  unknown identity.
- [x] The API tests use real encrypted rows and positive controls for A and B.
  Removing the scope checks produces runnable wrong answers and red tests.
- [x] A separate test demonstrates that reading the raw key still decrypts B's
  envelope despite the API refusal. Incidental cross-project access is prevented;
  deliberate key reads are not.
- [x] The refusal returns the existing uncredentialed result (`[]` / `null`),
  with no secret-bearing error or diagnostic added.

Verification: `bun test gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts`
and `bun test gateway/composition/build-core-modules-mcp-active-project.test.ts`.
