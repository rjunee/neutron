## 2026-09-24 — Exempt only complete read-only clauses from file claims

Issue #1294 exposed a false admission conflict: executing the existing Open E2E
test claimed ownership because its filename contains `build`. Recognizing write
verbs in arbitrary prose also missed real edits when later nouns such as `test`
or `read` were interpreted as instructions that canceled the write.

`trident/claimed-paths.ts` now defaults to claiming every recognized path. It
omits paths only when their complete clause matches a narrow read-only or
prohibition grammar. Canonical direct read/path lists, test/typecheck/script
invocations and explicit prohibitions have writable and read-only siblings.
Read-only labels do not bypass complete-clause validation. Unknown prose,
unsupported command forms, mixed writes and incomplete matches retain claims.
This deliberately overclaims ambiguous prose: `Edit X and run Y` claims both
recognized paths; `Edit X; run Y` claims only X. A bare `and` never separates
verbs that may share an object, such as `Edit and test X`.

Within a line, a non-exempt clause with no recognized object stays attached to
the next path-bearing clause, including its boundary. Thus `Edit then run X`
cannot become a standalone read exemption, and fragments cannot be joined to
manufacture a new prohibition. A complete objectless prohibition can close
independently, so `Do not edit; run X` remains read-only. A newline starts an
independent instruction; the parser does not infer missing write objects across
document lines. This keeps an as-built-directory instruction from claiming the
following explicitly marked E2E execution line.

One recognizer owns normalization and source ranges. Only accepted paths become
path tokens; `Edit/update` remains visible because it is not a path. Existing
extension and line-reference handling, the backtick bound, deduplication,
source order and the 64-path cap remain. There is no filesystem probe, wildcard,
schema change or structured-claims override. This is a bounded estimate of
named-path contention, not proof of all files a build might modify. The atomic
store implementation is unchanged; separate concurrency work is not included.

Focused validation: `bun test trident/claimed-paths.test.ts trident/store.test.ts`
passed 203 tests. Actual store admission accepts canonical read-only tasks
beside a live writer, persists legitimate claims, refuses real overlaps and
inserts no row after refusal. Tests cover the mixed-instruction, slash-verb and
read-noun reviewer counterexamples with canonical read-only siblings.

A sanitized equivalent of the General controls task and plan (#1293), with all
reference clauses explicitly marked, claims only the app client and test files.
The exact live task and saved plan were also checked: their E2E, Trident config
and script references are omitted, while unmarked component, authority and
gateway narrative references remain conservatively claimed. The sanitized
fixture does not assert more precise behavior for that original prose.

Five temporary semantic mutants failed assertions without parser errors:
discard unresolved prefixes (3 failures); disable exemptions (19 failures);
accept a read-head prefix without consuming the clause (2 failures); bypass
atomic path refusal (1 failure); apply live path claims to every admission,
including readers (1 failure). All were restored.

The publication receipt must identify the frozen head and outcomes of the
consuming `open/__tests__/project-build-e2e.test.ts`, root and Trident TypeScript
checks, and independent review. Full shared-host validation, CI, deployment and
the served Work Board witness remain separate gates. Focused results neither
establish them nor complete the broader efficiency acceptance.
