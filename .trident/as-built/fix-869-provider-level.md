## Issue 869 — provider refusal names its selection level

### Built

The three-level resolver still returns the selected provider and its source with project-over-instance precedence and an application fallback (`runtime/adapters/select-substrate.ts:122-133`). The Open composer now retains that complete selection before preparing a project build and passes both fields onward (`open/composer.ts:1164-1172`). `ProjectBuildContext` carries the source as the existing closed selection-source type (`open/wiring/project-build.ts:18-29`).

The existing non-Anthropic acting-turn refusal remains the only changed chokepoint and still returns `kind: 'refused'` with `reason: 'capability-unsupported'`; its detail now names both provider and selection level (`open/wiring/project-build.ts:55-66`). This joins the existing bounded-work vocabulary, where `refused` and `unknown` are distinct outcomes and `capability-unsupported` is an existing refusal reason (`runtime/bounded-work.ts:103-115`). No default behavior changed: callers continue to receive the same refusal classification.

### Evidence and citation corrections

The issue's `runtime/adapters/select-substrate.ts:122-133` citation remains exact. The current loss of source was specifically at `open/composer.ts:1170` before this change; after retaining the selection it is repaired at `open/composer.ts:1164-1172`. The existing refusal cited by the narrowed task is at `open/wiring/project-build.ts:60` after this change.

The focused test uses the same unwired `pi` provider for project, instance, and application sources, asserts each source appears, and asserts all three messages differ (`open/__tests__/project-build-wiring.test.ts:161-184`). The application case is the positive control for the default level (`open/__tests__/project-build-wiring.test.ts:165-183`).

### Decisions

I threaded provenance through the existing context instead of resolving it again, because the composer already owns project-aware resolution (`open/composer.ts:1164-1172`). I changed only the detail string guarded by `context.provider !== 'anthropic'`, leaving the condition and refusal taxonomy untouched (`open/wiring/project-build.ts:59-66`). The context field is required so future callers cannot silently omit attribution (`open/wiring/project-build.ts:18-29`).

### Mutation table

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Provider refusal detail at `open/wiring/project-build.ts:60` includes `context.providerSource` | Replaced it with the compiling provider-only message; printed the mutated line at line 60 | `bun test open/__tests__/project-build-wiring.test.ts`: 6 pass, 1 fail, 52 assertions; expected `selected at project level`, received `No live acting-turn binding for pi` | Same command: 7 pass, 0 fail, 57 assertions |

`bunx tsc -p open/tsconfig.json --noEmit` completed with exit code 0 after restoration.

### Deliberately not done

I did not add another refusal site, change when refusal occurs, add a fallback, or alter the `unknown`/`refused` taxonomy. I did not modify product decisions or broader provider resolution because the narrowed acceptance criterion required only attributable refusal text. No `SPEC.md` decision changed.
