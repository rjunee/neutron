---
title: Project-partitioned GBrain memory
issue: 605
date: 2026-09-15
---

## Project-partitioned GBrain memory

### What changed

`resolveGbrainClientOptions` now requires a project slug and selects that value as
the GBrain source (`gateway/wiring/build-gbrain-memory.ts:471-474`,
`gateway/wiring/build-gbrain-memory.ts:525-529`). The live builder passes its
existing project slug into that resolver (`gateway/wiring/build-gbrain-memory.ts:681-690`).
The stdio environment composer already writes the selected source after all other
environment layers, so it remains authoritative for the child process
(`gbrain-memory/gbrain-stdio-client.ts:107-135`).

The focused test uses two stores backed by a shared, source-partitioned fixture,
writes the same entity slug with different facts, and proves each project can
retrieve only its own fact (`gateway/wiring/__tests__/build-gbrain-memory.test.ts:88-124`).
It also pins that a process-wide source value cannot replace the project slug
(`gateway/wiring/__tests__/build-gbrain-memory.test.ts:67-85`).

### Decisions

The project slug replaces both the process-wide source override and the `default`
fallback. This is one path, not a compatibility branch: a process-level value
would recreate the cross-project partition. `GBRAIN_BRAIN_ID` remains an optional
instance-level setting (`gateway/wiring/build-gbrain-memory.ts:564-566`).

The invariant is maintained at every live memory-client composition by the
required `project_slug` input and the resolver assignment; it does not depend on
GBrain or a caller detecting a collision after the fact
(`gateway/wiring/build-gbrain-memory.ts:471-474`,
`gateway/wiring/build-gbrain-memory.ts:681-690`). No new error or verdict was
introduced, so there is no outcome vocabulary to extend.

The stale architecture prose was updated wherever the scoped search found the old
single-partition claims: `gbrain-memory/AGENTS.md:13-15`,
`connect/shared-project-memory-mirror.ts:19-26`, `connect/member-join.ts:100-117`,
and `docs/SYSTEM-OVERVIEW.md:4991-5000`. The enumeration used one repository search
over the distinctive old phrases plus `project slug` as a positive control; the
positive control matched the new statements and none of the old phrases remained
in the inspected files.

### Mutation proof

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Project slug is the source (`gateway/wiring/build-gbrain-memory.ts:529`) | Replaced it with the former process-wide value or `default`; the printed mutation landed at line 529 | `bun test gateway/wiring/__tests__/build-gbrain-memory.test.ts`: 5 failed, including `two projects round-trip entities only through their own source partition` | Same command: 72 passed, 0 failed |

### Validation

- `bun test gateway/wiring/__tests__/build-gbrain-memory.test.ts`: 72 passed, 0 failed.
- `bash scripts/ci/lint.sh`: passed all checks.
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 configurations passed, including
  `gateway/tsconfig.json`, `gbrain-memory/tsconfig.json`, `connect/tsconfig.json`,
  and the root `tsconfig.json`. `app/tsconfig.json` failed before reaching changed
  code because the ambient `@types` definition was unavailable.

### Deliberately not changed

The shared-project mirror was not activated. Its production seam still lacks the
cross-instance HTTP snapshot transport (`connect/member-join.ts:100-117`). No
feature flag, alternate memory backend, migration, or spec decision was added.
