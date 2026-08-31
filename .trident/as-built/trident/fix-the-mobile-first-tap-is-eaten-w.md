## 2026-08-31 — mobile: the first tap lands while the keyboard is open — keyboardShouldPersistTaps on every app/ scrollable, gated in CI

Owner report: with the keyboard up, tapping a control closed the keyboard but the tap never
registered — everything needed a second tap. React Native defaults a scrollable to
`keyboardShouldPersistTaps="never"`, so the first tap outside the input is consumed by the
keyboard dismissal before it reaches the Pressable. The repo knew the fix and applied it in
exactly one place (`app/app/login.tsx`); the other 44 scrollable sites under `app/` did not.

Every scrollable under `app/` now declares the prop or argues its exemption. 42 sites took
`keyboardShouldPersistTaps="handled"` — the chat path first (the FlashList transcript in
`ChatSyncSurface`, `ProjectRail`, `ProjectTabBar`), then every modal/drawer carrying a
TextInput (`ReminderEditModal`, `TaskEditModal`, `ProjectSettingsDrawer`, `CommentsSidePane`,
`ActivityInspectorDrawer`), then the remaining panes — joining the one pre-existing site for
43 in all. Two tappable-free scrollables (`MemoryPane`, the backups diff body) instead carry
an in-tag `KEYBOARD-TAPS-EXEMPT:` comment naming why: per the card, the prop is never added
just to satisfy a guard, and the value is always `"handled"`, never `"always"` — `"handled"`
still dismisses the keyboard on a tap that hits nothing, so the keyboard cannot become
impossible to dismiss.

A CI gate keeps it fixed (`scripts/ci/keyboard-taps-check.mjs`, CHECK 7 in
`scripts/ci/lint.sh`): a TypeScript-AST matcher over every `ScrollView`/`FlashList`/`FlatList`
opening tag under `app/` — immune to the type positions (`useRef<ScrollView | null>`) a grep
miscounts — fails any site with neither the prop nor a justified in-tag exemption, and a bare
marker with no reason is its own offense. The gate refuses to read an empty extraction as a
pass: a hard-coded positive control must reproduce its known offenses, a negative control must
produce zero, and walking zero files or matching zero sites each exit 1 — on this tree it
reports 45 sites, 2 exempt.

**Verified:** the prop is present at source on all 45 sites (now gate-enforced); FlashList
2.3.2 forwards it to its compat ScrollView (`FlashListProps extends Omit<ScrollViewProps, ...>`
at dist/FlashListProps.d.ts:31, `{...rest}` spread at dist/recyclerview/RecyclerView.js:357);
the chat transcript's ask is pinned by `app/__tests__/chat-keyboard-taps-ask.test.tsx`; the
PR #21 Android keyboard-inset tests pass untouched. **Not verified:** actual first-tap delivery
with a real keyboard up — unit tests do not exercise native touch dispatch, so a green suite is
not evidence the tap lands; this needs a device/simulator check (focus the composer, single-tap
a rail icon: it must register first time, and a tap on empty space must still dismiss the
keyboard).
