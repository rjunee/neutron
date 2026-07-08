// Root ESLint flat config — L5 (world-class-refactor plan).
//
// Sole job today: enforce `import/no-relative-packages`. This repo is a bun
// workspace monorepo of `@neutronai/*` packages; a relative import that
// crosses a workspace-package boundary (`../<other-workspace>/...`) is a
// layering smell the depcruise G4 gate can't see (it only tracks resolved
// module edges, not specifier shape) and silently couples packages without
// updating their `package.json` `dependencies`. Every cross-package import
// must use the `@neutronai/<pkg>/...` specifier instead.
//
// This is intentionally the ONLY rule wired here — no style/formatting rules,
// no duplicate of `app/eslint.config.js` (the Expo app's own React Native
// lint pipeline, which is unrelated and untouched by this config). Scoped to
// `.ts`/`.tsx` source across the repo; `app/` is included too since it is a
// workspace package like any other and can escape just as easily.
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/coverage/**',
      '**/.expo/**',
      // L5's scope is the `@neutronai/*` TS workspace import graph. Plain
      // `.js`/`.mjs`/`.cjs` scripts (build tooling, prototypes) aren't part of
      // that graph and aren't covered by any `files` block below, so without
      // an explicit ignore ESLint 9 still tries to parse them under its
      // built-in default JS matching and can report spurious parse errors
      // (e.g. top-level-await wrapper scripts using `return`).
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
      ecmaVersion: 'latest',
    },
    // This config only registers one rule. Files also linted by their own
    // package-local config (e.g. `app/eslint.config.js`) may carry
    // `eslint-disable` comments for rules this config never loads — don't let
    // those show up as "unused directive" / "rule not found" noise here.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      // `ignore` holds the two L5 sweep exceptions that must stay relative
      // (see docs/plans/... PR body for the full writeup):
      //  - `tests/support/test-isolation.ts` is shared test-support code that
      //    lives at the repo root but is NOT a workspace package (it isn't in
      //    package.json `workspaces`), so it has no `@neutronai/*` specifier
      //    to rewrite to — `findNamedPackage` would otherwise misattribute it
      //    to the root "neutron" meta-package and mint a bogus
      //    `neutron/tests/support/...` specifier that resolves nowhere.
      //  - `connect/__tests__/trusted-accept-handler.test.ts`'s import of
      //    `onboarding/api/invite-link-generate.ts`: `onboarding` already
      //    depends on `@neutronai/connect`, so declaring the reverse
      //    dependency would create a circular package edge. Left relative
      //    pending a real decoupling (out of scope for a pure-rename sweep).
      'import/no-relative-packages': [
        'error',
        {
          ignore: ['tests/support/test-isolation\\.ts$', '^\\.\\./\\.\\./onboarding/api/invite-link-generate\\.ts$'],
        },
      ],
    },
  },
];
