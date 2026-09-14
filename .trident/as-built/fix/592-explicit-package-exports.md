## 2026-09-14 — Curate the jwt-validator package exports

### What changed

The publishable package now exports its existing bare entry, `index.ts`, and `claims.ts` explicitly (`jwt-validator/package.json:5-9`). The root manifest provides a focused resolution check that imports the sanctioned `index.ts` subpath and fails if the internal `resolve-key.ts` subpath resolves (`package.json:57-63`).

The entry-point list came from a repository-wide search of TypeScript import specifiers, not a directory listing. `rg -n "(?:from|import\\() ['\\\"]?@neutronai/jwt-validator(?:/[^'\\\"]*)?['\\\"]" --glob '*.ts' .` found the known `index.ts` import at `connect/api/jwt-bearer-middleware.ts:20` as its positive control and one `claims.ts` import at `connect/api/jwt-bearer-middleware.ts:21`. Normalizing the matched specifiers with a second repository-wide `rg -o` enumeration yielded only the bare name, `index.ts`, and `claims.ts`; the bare-name hit is explanatory prose, while the executable imports use the two explicit subpaths. The `claims.ts` entry remains because that existing consumer is within the current compatibility surface.

The manifest-map search `rg -n '\"(?:exports|typesVersions)\"|\"\\./\\*\"' --glob 'package.json' jwt-validator package.json` positively found `exports` at `jwt-validator/package.json:6` and the former wildcard at line 8, and found no `typesVersions` key. There was therefore no parallel types map to narrow.

### Decisions and maintained boundary

The explicit list follows the module's documented public barrel and claims surface (`jwt-validator/AGENTS.md:5-9`) while preserving the observed consumer. `validator.ts` and `resolve-key.ts` are not separately exported because their public values are re-exported by the barrel (`jwt-validator/index.ts:13-24`). No compatibility path or flag remains.

Package resolution continuously maintains the boundary from the `exports` map (`jwt-validator/package.json:6-9`); it does not depend on an internal module continuing to behave correctly. A blocked subpath joins Bun's existing module-resolution failure vocabulary. The focused check catches that rejection, while an unexpectedly successful internal resolution reaches the script's default failure (`package.json:62`).

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Explicit export map at `jwt-validator/package.json:6-9` | Replaced the two explicit subpaths with the original `\"./*\": \"./*\"`; the printed mutation landed at line 8 | `bun run test:jwt-validator-exports` exited 1 with `internal subpath resolved` | Restored explicit entries; command exited 0 |

### Verification

- `bun run test:jwt-validator-exports` — green after restoration.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations passed, including `connect/tsconfig.json` and `jwt-validator/tsconfig.json`.
- `bash scripts/ci/lint.sh` — all repository lint guards passed.
- `git diff --check` — clean.
- `bash scripts/ci/leak-gate.sh --tree .` — zero findings from every locally available rule; exit 3 because the out-of-band PII list is not available in this lane, so the PII rules could not run.

### Deliberately not changed

No source import was rewritten because both currently imported subpaths remain sanctioned. No `typesVersions` map was added, no sibling package was changed, and no product decision in `SPEC.md` or a spec item changed.
