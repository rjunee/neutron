## 2026-10-05 — Codex admission shares authenticated process observation

The previous local census selected processes by proc inode owner and required
the ordinary caller to read every relevant executable. Protected userspace tasks
could therefore make admission unknown; treating their displayed names as proof
of absence would have broken account exclusion. The earlier kernel-task change
remains valid but does not solve protected userspace observation.

`runtime/adapters/codex-cli/codex_account_observation.py:166` is now the single
classifier. It derives membership from all four credential UID fields, verifies
PID/start and executable identity before excluding userspace, retains the stable
kernel-task distinction, and repeats classification and complete enumeration.
Account identities combine canonical directory path and device/inode through a
domain-separated opaque digest (`:68`). Target-root directory-descriptor traversal
checks the account's actual filesystem identity across read-only mount namespaces
(`:90`). No auth file is opened by observation.

`runtime/adapters/codex-cli/codex_account_client.py:274` selects complete local
observation only when the fixed operator pin is absent. A configured observer is
mandatory. The client checks protected pin/socket ancestry, exact schemas,
Ed25519 signatures, fresh challenge, caller identity, boot and bounded scan times
before returning consumers (`:169`, `:212`). It sends exactly one request and
half-closes its write side before receiving exactly one response and EOF. The
verifier is the fixed Linux `/usr/bin/openssl` executable with anonymous memory
descriptors; missing verification refuses.

Both native launch and auth mutation retain the existing account reservation and
native lifetime-lock mechanism. `account-writer.py:76` compares the verified
observation with stable directory identity; its launch keeps the native lock
through exec and always supplies canonical CODEX_HOME (`:179`). The TypeScript
mutation lease also rechecks the directory and named reservation inode around
the Python probe (`account-writer-lock.ts:38`, `:64`). Helpers do not gain native
lock ownership, and observer evidence is not a replacement lifetime lease.

Review found that equal root/account inodes do not establish equal NSS provider
views in different mount namespaces. A regression first failed against that
insufficient implementation while the same-namespace NSS positive passed. The
classifier now requires equal mount namespace and root identity for missing
HOME/CODEX_HOME fallback. Explicit HOME/CODEX_HOME still permits independently
verified account identity across read-only mounts. This limitation is explicit
in the normative protocol; protected observation does not guess another
namespace's NSS home.

Validation measured in this change:

- The named admission, project-owner/bootstrap, build/review, durable owner,
  credential/grant, HTTP and production-binding group passed 446 tests across
  11 files, with 3,023 assertions.
- After the final NSS guard and request half-close changes,
  `runtime/adapters/codex-cli/account-writer-lock.test.ts` passed all 17 tests
  and 59 assertions. Its Python controls include 14 classifier tests, 10 real
  signature/client tests and 12 executable semantic mutants. Every selected
  valid control passes; both unsafe-admit and always-refuse mutants fail.
- The real private-process boundary still finds same-account unwrapped natives,
  permits distinct accounts, rejects unreadable insiders, and preserves native
  exclusion after helper death. Fixtures actuate only their own synthetic work.
- `scripts/ci/typecheck-all.sh` passed every one of 51 owned TypeScript projects,
  including root and app. Whitespace validation passed.
- The actual leak gate found zero findings in an added-content snapshot covering
  every new file and every added diff line. A full local tree scan remains red
  on existing-content denylist matches and linked-worktree metadata; the scoped
  screen is not a full-tree or CI pass.

The separate protected-observer implementation owns its server-side
SO_PEERPIDFD authentication, complete host-view proof, bounded worker, protected
installation and service lifecycle. This record does not claim its deployment or
ordinary-host consuming acceptance. `open/__tests__/project-build-e2e.test.ts`
and the canonical full repository gate remain required on the integrating tree;
their coordinating gate owner avoids duplicate runs. Snapshot observation still
does not exclude a later unwrapped launch. No account custody, credential copy,
service actuation or new feature flag is introduced.
