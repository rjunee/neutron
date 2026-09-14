## 2026-09-14 — Bound narrow PII matches at identifier components

### What changed

The narrow `word:` denylist mode remains case-sensitive, but it now recognizes camel-case component edges in addition to punctuation and string edges (`scripts/ci/leak-gate.sh:448-456`, `scripts/ci/leak-gate.sh:489-497`). A shared pattern builder feeds the tree rule, commit-message rule, and local diagnostic (`scripts/ci/leak-gate.sh:527-530`, `scripts/ci/leak-gate.sh:577-580`, `scripts/ci/leak-gate.sh:609`, `scripts/ci/leak-gate.sh:731`), so all three surfaces keep the same boundary.

The real out-of-band list was neither read nor copied. Both focused suites construct synthetic fixture entries (`scripts/ci/leak-gate-selftest.test.ts:374-383`, `scripts/ci/leak-gate-explain.test.ts:126-137`). The gate test now proves that `openMarbleImport` is caught while `Marbles` is not (`scripts/ci/leak-gate-selftest.test.ts:1174-1191`); a separate lowercase fixture prevents a false lower-to-lower edge (`scripts/ci/leak-gate-selftest.test.ts:1199-1207`). The diagnostic test proves the same component rule is used for local match counts (`scripts/ci/leak-gate-explain.test.ts:126-137`).

### Decision and boundary

Ordinary denylist entries intentionally remain case-insensitive separator-flexible substrings for path-like and identifier-like secrets (`scripts/ci/leak-gate.sh:436-446`). The `word:` exception remains case-sensitive and now accepts a boundary at start/end, punctuation, or a lower/digit-to-uppercase camel-case edge (`scripts/ci/leak-gate.sh:448-456`, `scripts/ci/leak-gate.sh:477-478`, `scripts/ci/leak-gate.sh:489-497`). This catches a proper noun embedded as a camel-case component without treating a lowercase suffix as a boundary.

The rule deliberately does not split all-uppercase runs, detect case-changed spellings, or match a token followed by lowercase letters (`scripts/ci/leak-gate.sh:453-456`). Thus `Marbles` stays innocent. Those limits preserve the purpose of the narrow mode; callers needing broader detection retain the ordinary substring mode (`scripts/ci/leak-gate.sh:436-451`).

The new result joins the existing `pii-denylist-word` and `pii-denylist-word-msg` vocabulary (`scripts/ci/leak-gate.sh:609`, `scripts/ci/leak-gate.sh:731`). Existing reporting counts either as a finding and fails the gate by default (`scripts/ci/leak-gate.sh:318-329`, `scripts/ci/leak-gate.sh:851-860`). The shared `word_component_pattern` function continuously maintains identical matching across the tree, message, and diagnostic consumers; it does not depend on the party supplying the secret list beyond providing data (`scripts/ci/leak-gate.sh:489-497`, `scripts/ci/leak-gate.sh:527-530`, `scripts/ci/leak-gate.sh:577-580`).

The filed issue's diagnostic citation moved from `scripts/ci/leak-gate.sh:516-578` to `scripts/ci/leak-gate.sh:532-596` after this change; its CI refusal remains at `scripts/ci/leak-gate.sh:197-201`.

### Mutation evidence

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| Component boundary builder at `scripts/ci/leak-gate.sh:489-497` | Restored the old punctuation-only expression; the printed mutated line was `printf '(^|[^A-Za-z0-9_])(%s)([^A-Za-z0-9_]|$)'` | `bun test scripts/ci/leak-gate-selftest.test.ts scripts/ci/leak-gate-explain.test.ts -t 'component-bound'` failed because `openMarbleImport` produced no `pii-denylist-word` finding | Restored component expression; focused suite green |
| Lowercase-suffix exclusion at `scripts/ci/leak-gate.sh:489-497` | Widened the printed mutated line to unrestricted `printf '(%s)'` | `bun test scripts/ci/leak-gate-selftest.test.ts -t 'component-bounded'` failed because `Marbles` produced a `pii-denylist-word` finding | Restored component expression; focused suite green |
| Uppercase-only left-camel alternation at `scripts/ci/leak-gate.sh:478` | Replaced the uppercase filter with an empty-line filter; the printed mutated line was `if (kind=="word-upper" && line ~ /^$/) next` | `bun test scripts/ci/leak-gate-selftest.test.ts -t 'lowercase entry'` failed because `openmarbleImport` produced a `pii-denylist-word` finding | Restored uppercase filter; targeted test: 1 pass, 0 fail |

### Verification

- `bun test scripts/ci/leak-gate-selftest.test.ts scripts/ci/leak-gate-explain.test.ts` — 67 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations passed. The requested `bun run typecheck` has no package script (`package.json:59-63`), so the repository's documented command was used (`CONTRIBUTING.md:77`).
- `bash scripts/ci/lint.sh` — all repository lint guards passed.
- An exported-tree run of `scripts/ci/leak-gate.sh` with a synthetic fixture entry — 0 findings and a silent verdict. The live worktree form cannot be used because its administrative pointer is intentionally inside the gate's all-files scan.

### Deliberately not changed

The ordinary substring entry semantics were not narrowed, the allowlist vocabulary was not extended, and no private denylist data was inspected or committed. No product decision in `SPEC.md` or a spec item changed.
