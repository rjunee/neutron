## 2026-09-28 — Incremental discovery for exact registered native sources

The whole-tree collector snapshots all dated rollouts before a caller can select
registered sources. Its aggregate file/byte limits therefore reject a large
history even when the required registrations form a small subset
(`scripts/build-timeline-codex-discover.ts:162`). Raising that aggregate limit
would retain unrelated transcript data and repeat the full read every refresh.

`importRegisteredCodexRollout` now validates one canonical dated path, opens a
verified descriptor and streams a fixed initial byte boundary without enumerating
the tree (`scripts/build-timeline-codex-discover.ts:76`). A private serializable
checkpoint retains relevant native context and receipts plus the captured byte
cursor and bounded unfinished-line bytes. Restarted refreshes read appended bytes;
unchanged sources read none, including sources with an unfinished final line.
Historical receipts are re-imported using the source's current attribution config,
so the cursor never becomes permission to borrow another registration's binding.
Incomplete final lines defer until completed. Hard bounds cover source size,
lines, individual line bytes and retained journal size.

The checkpoint is trusted private state. Its caller must atomically persist the
receipt journal together with its cursor and serialize refreshes. Replaying an old
cursor is deterministic; returned historical observations also permit recovery
after checkpoint persistence but before output journal persistence. Identity,
truncation, aliases and same-size rewrite checks fail closed. As in the existing
snapshot reader, append-only growth is assumed: a prefix rewrite combined with
growth is not detectable from stat identity alone. The original bounded automatic
whole-tree CLI retains its separate inventory purpose and limits.

Validation: 56 focused discovery/importer/registration/authenticated-server tests
passed, including a streamed source exceeding 128 MiB, zero-byte repeat,
checkpoint restart and crash replay, historical model/usage context, partial-line
continuation, exact source attribution, private-path redaction, oversized-line
refusal, replacement, rewrite and truncation. Root and Trident TypeScript checks
passed. Bidirectional semantic controls failed as intended: suppressing retained
receipts broke the authenticated dashboard positive control; accepting a same-size
checkpoint rewrite broke its refusal control. Restoring both changes returned all
21 discovery tests to green. Review also required unchanged partial lines to read
zero bytes. The checkpoint now persists bounded unfinished bytes with the captured
cursor; both rereading those bytes and discarding them were separately mutated and
rejected by the restart/append consuming test. The restored 56 focused tests and
both TypeScript checks passed again.

This change supplies the library mechanism and reviewed acceptance criteria.
Private consumer durability, operator backfill and served activation remain
separate deployment evidence; no live configuration or deployment changed here.
