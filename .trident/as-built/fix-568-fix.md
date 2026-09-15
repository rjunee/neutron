## Issue 568 — mobile light mode uses resolved themed styles

### Built

The mobile palette is now a runtime value. `DARK_THEME` preserves the existing literals and `LIGHT_THEME` mirrors the web semantic colors; the `THEME` and `PHASE` proxies select from those concrete palettes at property-read time (`app/lib/theme.ts:132-215`, `app/lib/theme.ts:303-325`). `createThemedStyles` keeps module-level style objects stable while resolving their palette-derived color properties when React Native reads them, then registers the complete styles through `StyleSheet.create` so non-colour layout properties retain the normal platform representation (`app/lib/theme.ts:252-295`).

The CI follow-up exposed a coupled layout case in the project rail. Every name reserves two caption lines through `TYPOGRAPHY.caption.lineHeight * 2` (`app/components/ProjectRail.tsx:490-505`), and caption line height is one appearance-independent 16-point token (`app/lib/theme.ts:395-404`). The regression was therefore neither a removed palette constant nor a light/dark mismatch: the first implementation returned raw style objects and bypassed React Native style registration. On the web test renderer that changed the reservation from an atomic class to an inline value, violating the pinned rendered-layout contract.

The root theme owner follows `useColorScheme`, defaults to `system`, restores a valid saved preference, persists later choices, and keys its subtree by the resolved light/dark value (`app/lib/theme-runtime.tsx:16-57`). It is mounted above the application navigator (`app/app/_layout.tsx:236-241`). Settings exposes System, Light, and Dark as an accessible radio group and displays System's current resolution (`app/app/settings.tsx:307-328`).

All 63 palette-bearing modules that declared a style sheet were enumerated with `rg -l '\bTHEME\b|\bPHASE\b' app components features lib --glob '*.{ts,tsx}'` followed by a declaration search. Each now declares `createThemedStyles`; the paired search found no `const styles = StyleSheet.create` among that set and positively found 63 `const styles = createThemedStyles` declarations.

The mobile README no longer describes the palette as dark-only (`app/README.md:73`, `app/README.md:162`). Historical plan and frozen as-built statements remain unchanged because they describe the state at the time those records were authored, rather than current behavior.

### Decisions

The persisted preference vocabulary is the web vocabulary: `system | light | dark`; `system` is the default and an explicit value wins over device appearance (`app/lib/theme.ts:155-168`). Corrupt, absent, or unreadable storage resolves conservatively to `system`, while a write failure leaves the current in-memory choice active (`app/lib/theme.ts:170-195`). This adds no new error/verdict vocabulary: storage failure remains non-fatal and has no user-facing error state.

The continuous maintainer of the appearance invariant is `AppThemeProvider`: the React Native appearance hook rerenders it on device changes, it sets the resolved palette before rendering, and its resolved-value key remounts the subtree (`app/lib/theme-runtime.tsx:30-57`). That mechanism does not depend on a screen or settings control remaining mounted.

The web source uses an active-state wash for selection, so `rail_selected` uses that existing value rather than inventing a mobile-only light blue (`landing/chat-react.html:187`, `app/lib/theme.ts:147`). Work, attention, usage, and phase colors likewise use the existing web light values (`landing/chat-react.html:170-176`, `landing/chat-react.html:211-225`, `app/lib/theme.ts:148-152`, `app/lib/theme.ts:313-320`).

### Verification

| Guard | Mutation | Red evidence | Restored green evidence |
|---|---|---|---|
| Resolved palette assignment (`app/lib/theme.ts:200-202`) | Replaced `resolvedTheme = next` with `resolvedTheme = 'dark'`; printed the landed mutation at line 201 | `THEME > resolves a different palette and existing themed style when appearance changes` failed: expected `#ffffff`, received `#101419` | `bun test __tests__/theme.test.ts __tests__/server-editor-reachability.test.ts`: 37 pass, 0 fail |
| React Native style registration (`app/lib/theme.ts:295`) | Replaced `return StyleSheet.create(styles) as T` with the compiling raw-object return `return styles`; printed the landed mutation at line 295 | `project names wrap instead of truncating > reserves both lines on a SHORT name too, so rows keep a uniform height` failed because the rendered short label had no minimum-height class | Restored named rail file: 10 pass, 0 fail; original theme and reachability files: 37 pass, 0 fail |

The theme tests pin both concrete palettes, runtime changes for direct tokens and already-created style objects, system/override resolution, and persistence behavior; their local React Native shim lets this otherwise-pure file load the new `StyleSheet` dependency (`app/__tests__/theme.test.ts:10-29`). The rail test pins a registered minimum-height class on both short and long names and positively controls that the create label has none (`app/__tests__/rail-unread-floats-and-counts.test.tsx:277-300`).

The requested surrounding runs were also executed. `bun test landing/chat-react/__tests__` enumerated 783 tests across 67 files: 764 passed and 19 pre-existing interaction-timing assertions failed. From `app/`, `bun test __tests__` enumerated 1,998 tests across 158 files: 1,812 passed and 186 failed after cross-file mock state contaminated later render tests; the subject file passes 10/10 in isolation. No broad-suite assertion was weakened or skipped.

The repository command `bun run typecheck` did not reach source checking: TypeScript reported TS2688 for an invalid implicit `@types` entry in the installed dependency tree. An explicit `bunx tsc --noEmit --types react` pass reached the changed source and reported only the existing unused suppression at `app/__tests__/support/mount.tsx:17`; it reported no changed-source error. Repository lint passed every reported guard, and `git diff --check` completed cleanly.

### Deliberately not changed

No feature flag or fallback implementation was added; the resolved path replaces frozen style capture. The row height was not pinned to either appearance: its existing typography-derived reservation remains unchanged. `SPEC.md` and spec items do not define a conflicting mobile appearance decision, so no product decision log changed. Historical plans and frozen as-built records were not rewritten. Only the two requested surrounding directories were run, not the repository-wide suite.
