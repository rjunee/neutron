## 2026-09-15 — Pin the repository's Node type resolution

### Change and evidence

The root development manifest now directly pins `@types/node` 25.9.1 at
`package.json:66`, and the root workspace entry records the same exact version at
`bun.lock:29`. The already-resolved package is `@types/node` 25.9.1 at
`bun.lock:1401`; the older transitive copy remains recorded at `bun.lock:3051`,
but TypeScript now finds the repository-root declaration before searching any
ancestor dependency directory.

The affected fixture imports the runtime-provided `crc32` export at
`onboarding/history-import/__tests__/zip-writer.ts:10`. The second filed failure
compares the installed bytes at
`gateway/transcription/__tests__/whisper-install.test.ts:186`. Neither call site
was suppressed or changed.

The pin is maintained continuously by the manifest/lockfile pair and checked at
installation by `bun install --frozen-lockfile`; it does not depend on an
ancestor dependency tree remaining usable. This introduces no runtime outcome,
error, verdict, or fallback, so there is no outcome vocabulary to extend.

### Decision

A direct exact development dependency was chosen instead of a package-manager
override. The direct dependency both pins the selected version and creates the
root ambient-type link where TypeScript begins its search. An override alone
could deduplicate transitive packages but would not state that this repository
itself requires Node declarations.

No spec item or `SPEC.md` decision changed. This is dependency-resolution repair
within issue #860's stated territory.

### Mutation evidence

The pin was removed from `package.json` and `bun.lock` together, and the generated
root link was removed. The mutation landing was printed immediately after
`package.json:65` and `bun.lock:28`, followed by the diff. The two targeted
TypeScript runs then failed at the filed lines. Restoring the declarations and
generated link made both runs green.

| Guard | Mutation | Red result | Restored result |
| --- | --- | --- | --- |
| Exact root `@types/node` declaration at `package.json:66` and `bun.lock:29` | Remove both declarations and the generated root link | `onboarding/tsconfig.json` reported TS2305 at `onboarding/history-import/__tests__/zip-writer.ts:10`; `gateway/tsconfig.json` reported TS2769 at `gateway/transcription/__tests__/whisper-install.test.ts:186` and TS2305 at the ZIP helper | Both configurations passed; `logger/tsconfig.json` also passed |

### Validation

- `bun install --frozen-lockfile --offline`: passed with no changes.
- `bun test onboarding/history-import/__tests__/chatgpt-export.test.ts gateway/transcription/__tests__/whisper-install.test.ts`: 33 passed, 0 failed.
- `bash scripts/ci/lint.sh`: every reported gate passed.
- `bash scripts/ci/typecheck-all.sh`: the two filed failures are gone; 50 of the dynamically enumerated 51 configurations passed. `app/tsconfig.json` alone reported TS2688 because TypeScript discovered a malformed ambient package above the build worktree. The complete count comes from the script's `find`-based enumeration at `scripts/ci/typecheck-all.sh:25` and final counter at `scripts/ci/typecheck-all.sh:76`.

### Deliberately not changed

No `@ts-expect-error`, call-site cast, test relaxation, runtime code, or alternate
typecheck path was added. The unrelated ambient package above the build worktree
was not modified. The older transitive package remains available to the SDKs
whose manifests request it; resolution for this repository is made deterministic
by the direct root dependency instead of by rewriting those third-party
manifests.
