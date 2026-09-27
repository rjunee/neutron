## 2026-09-27 — Measure dependency bytes across shared-cache hardlink churn

An independent frozen Bun installation reproduced a false suite-identity change
in an already installed dependency tree. All 152 entries and their traversal
order remained identical; 132 regular files changed only their inode change
time (`ctime`) when the other installation added hardlinks. A third installation
repeated the result while SHA-256 measurements of all 132 files, totaling
23,625,066 bytes, remained identical. File device, inode, mode, size, modification
time, type and link target did not change. The earlier full-suite success remains
unusable under its mismatched receipt; this change does not transfer that proof.

Regular-file identities now include content SHA-256, UID/GID, permissions,
device/inode, size and modification time. They omit persisted `ctime`, while
retaining it in the before/after read stability checks. Both installed-tree and
declared-entrypoint resolution measurements use the same host-owned reader
(`open/wiring/project-build-dependencies.ts:70`, `:131`). Preparation also binds
the helper source and Python executable identity (`:107`). This preserves the
measured-input contract in `docs/spec-items/trident-build-efficiency.md:180` and
the shared-cache inode contract in `docs/spec-items/native-bun-cache-hardlinks.md:41`.

The Python helper opens every path component relative to pinned directory
descriptors with `O_NOFOLLOW`, validates the root binding, and checks file and
directory stability before accepting its observation
(`open/wiring/project-build-installed-tree.py:31`, `:69`, `:128`). It runs from
the host with isolated Python startup, bounded output, traversal, descriptor use
and a deadline. The five-second installed-tree budget remains unchanged. A
hardlink operation during a read can conservatively refuse that observation;
a stable retry succeeds. Directory timestamps are still transient stability
evidence even where existing workspace-directory normalization removes them
from the saved key.

Local validation covered hardlink addition/removal, exactly restored modification
times with changed bytes, unchanged-byte replacement, permissions and ownership
binding, valid local links, and root/ancestor/leaf retargets without reading
external bytes. The consuming E2E control retains one install and one host suite
through publication after actual hardlink churn; its existing changed-input
sibling still refuses stale proof (`open/__tests__/project-build-e2e.test.ts:2575`).
Semantic mutants exercise omitted content, persisted regular-file `ctime`,
missing in-read `ctime` checks, missing namespace checks and reject-all behavior.

Checks: root and Trident TypeScript preflights passed. The focused identity,
native-reader and semantic-mutation tests passed (27 tests, 178 assertions,
13.68 seconds); the two consuming E2E controls
passed (7.08 seconds). Before implementation, the explicitly invoked complete
identity/E2E baseline passed 375 tests; that baseline is not proof of the changed
implementation. The coordinated integration gate must run the complete suite
again, followed by exact-head CI and the deployed positive/negative controls.
The corrected observer also retained one identical installed identity before,
during and after adding a link to an actual Bun-cache-shared inode, with its
changed `ctime` and unchanged inode verified independently.

A real dependency tree with 69,524 unique regular files and 1,044,814,946 bytes
produced a known complete suite identity in 5.184 seconds overall. Two simultaneous
observations produced the same known identity in 5.164 seconds each; each
installed-tree phase met its five-second deadline. These are warm local
measurements, not cold-cache or arbitrary-load guarantees. Full integration,
remote CI, merge, deployment and a new unattended live success were not claimed
by these focused checks.
