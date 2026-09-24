## 2026-09-24 — Derive write claims from instructions and accepted path ranges

Issue #1294 exposed a false admission conflict: executing the existing Open E2E
test claimed ownership because its filename contains `build`. The earlier
line-wide write and negation checks also let a read-only instruction or guard
rail hide a later explicit write.

`trident/claimed-paths.ts` now recognizes and normalizes candidate paths once,
then masks exactly those accepted source ranges while interpreting instruction
words in source order. Filename verbs cannot become instructions; slash-joined
verbs such as `Edit/update` remain visible because they are not accepted paths.
Read instructions change the action associated with subsequent paths. Explicit
write instructions remain observable after unfamiliar filler or a preceding
read instruction. Negation ends at a sentence boundary or an explicit transition
such as `but` or `then`. This remains a bounded lexical heuristic for likely
write ownership, not a natural-language parser or a filesystem probe.

Normalization retains extensions, line references, rejected absolute/escaping
paths, the backtick span bound, deduplication and the 64-claim cap. Claims follow
source order, including interleaved bare and backticked paths. The atomic store
transaction is unchanged.

Focused validation: `bun test trident/claimed-paths.test.ts trident/store.test.ts`
passed 191 tests. The new store test admits read-only tasks beside a live writer,
persists legitimate claims, refuses actual overlaps and verifies no row was
inserted after refusal. It includes all three mixed-instruction review
counterexamples and slash-joined edit/create verbs with read-only siblings.

Four temporary semantic mutants were rejected by assertions, without parser
errors: suppress every parser claim (15 failures); claim every recognized path
(8 failures); bypass the atomic path check (1 failure); apply live path claims
to every admission, including readers (1 failure). All mutations were restored.

The publication receipt must identify the frozen head and outcomes of the
consuming `open/__tests__/project-build-e2e.test.ts`, root and Trident TypeScript
checks, and independent review. Full shared-host validation, CI, deployment and
the served Work Board witness remain separate gates; these focused results do
not establish them or complete the broader efficiency acceptance.
