// Root ESLint flat config — L5 (world-class-refactor plan).
//
// Enforces ONE rule: `import/no-relative-packages`. This repo is a bun
// workspace monorepo of `@neutronai/*` packages; a relative import that
// crosses a workspace-package boundary (`../<other-workspace>/...`) is a
// layering smell the depcruise G4 gate can't see (it only tracks resolved
// module edges, not specifier shape) and silently couples packages without
// updating their `package.json` `dependencies`. Every cross-package import
// must use the `@neutronai/<pkg>/...` specifier instead.
//
// EXACTLY what this config catches (no overclaiming):
//   * STATIC cross-package relative imports/exports/`export * from` — with OR
//     without a file extension. The `import/resolver: typescript` setting
//     below is load-bearing for the EXTENSIONLESS case: `no-relative-packages`
//     resolves the specifier to a concrete file, then compares the importer's
//     package to the target's. Without a TS-aware resolver, an extensionless
//     `../../channels/adapters/app-ws/envelope` (a `.ts` file) fails to
//     resolve, so the rule silently skips it (this was the Codex-flagged hole).
//   * `require('../<pkg>/...')` calls (moduleVisitor covers CommonJS too).
//
// What this config CANNOT catch — enforced elsewhere, NOT here:
//   * `import('../<pkg>/...')` TYPE-QUERY / dynamic-import EXPRESSIONS. ESLint's
//     `no-relative-packages` (via eslint-module-utils' moduleVisitor) only
//     visits import/export DECLARATIONS + `require()`; it does not lint
//     expression-position `import()` at all. Those cross-package type-queries
//     are swept + gated separately by a grep check in `scripts/ci/lint.sh`.
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
    settings: {
      // eslint-import-resolver-typescript — resolves `.ts`/`.tsx` and
      // EXTENSIONLESS specifiers so `no-relative-packages` can tell whether an
      // extensionless relative import crosses a package boundary. The project
      // globs cover every leaf/package tsconfig in the repo (same set the tsc
      // matrix in scripts/ci/typecheck-all.sh discovers); a new package with a
      // tsconfig is picked up automatically.
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: [
            'tsconfig.json',
            '*/tsconfig.json',
            'cores/tsconfig.json',
            'cores/*/tsconfig.json',
            'cores/free/*/tsconfig.json',
            'landing/*/tsconfig.json',
          ],
        },
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      // `ignore` holds the two L5 sweep exceptions that must stay relative
      // (see PR #280 body for the full writeup):
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
