## Issue 568 — mobile light mode uses resolved themed styles

### Built

The mobile palette is now a runtime value. `DARK_THEME` preserves the existing literals and `LIGHT_THEME` mirrors the web semantic colors; the `THEME` and `PHASE` proxies select from those concrete palettes at property-read time (`app/lib/theme.ts:132-215`, `app/lib/theme.ts:304-326`). `createThemedStyles` keeps module-level style objects stable while resolving their palette-derived color properties when React Native reads them (`app/lib/theme.ts:256-276`).

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

The theme tests pin both concrete palettes, runtime changes for direct tokens and already-created style objects, system/override resolution, and persistence behavior (`app/__tests__/theme.test.ts:14-113`). Changed-file ESLint completed with zero findings. `git diff --check` completed cleanly.

The repository command `bun run typecheck` did not reach source checking: TypeScript reported TS2688 for an invalid implicit `@types` entry in the installed dependency tree. An explicit `bunx tsc --noEmit --types react` pass reached the changed source and reported only the existing unused suppression at `app/__tests__/support/mount.tsx:17`; it reported no changed-source error.

### Deliberately not changed

No feature flag or fallback implementation was added; the resolved path replaces frozen style capture. `SPEC.md` and spec items do not define a conflicting mobile appearance decision, so no product decision log changed. Historical plans and frozen as-built records were not rewritten. The full test suite was not run, per the lane's bounded-validation instruction.
