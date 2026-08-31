# IMPLEMENTATION_PLAN — web chat bundle ships the DEV JSX runtime (build-config fix)

Card: `resolveChatReactJs`'s `Bun.build` never defines `process.env.NODE_ENV`, so Bun emits the DEVELOPMENT JSX transform for the browser SPA — every element goes through `jsxDEV`, which records an owner stack via `console.createTask` (~60% of a project-switch profile; frames of 2.6 s). Fix = `define: { 'process.env.NODE_ENV': '"production"' }` in that one build config, plus a regression test on the BUILT BUNDLE TEXT.

Verified against the tree at main @ 187a9209:

- [x] (verified defect) `landing/server.ts:792-800` — the chat-react `Bun.build` call carries `target/format/minify/sourcemap` but NO `define`. Card's measurements stand: baseline 1,092,148 bytes / 854 `jsxDEV` / 6 `console.createTask` / 7 `OwnerStack`; with the define 849,843 / 3 / 0 / 0. Env var on the server process is a measured no-op — the `define` is the only fix.
- [x] (verified) deploy path: no prebuilt `landing/static/chat-react.js` exists and no packaging script builds one — the deployed bundle IS this lazy `Bun.build`, so fixing these options fixes production.
- [x] (verified) `landing/__tests__/chat-react-bundle-builds.test.ts:24-30` copy-pastes a second set of build options — exactly the drift the card forbids the new test to repeat; extraction of a shared exported constant is the required shape.
- [x] (verified) positive control `car-conv` is real and reachable: `landing/chat-react/ChatApp.tsx:2078` (className on the always-mounted conversation surface — survives minification as a string literal).
- [x] (verified constraints) ETag/versioned-shell code (`landing/server.ts:841-880`) is correct and must not change (`chat-react-serving.test.ts` pins it). `docs/AS_BUILT.md` is one-writer — `scripts/ci/as-built-write-guard.sh` FAILS any PR whose diff names it; do not write it (recent PRs land without a staged entry, and the card's scope fence excludes one).

One atomic task: the card requires the MERGED state to carry both the define and the bundle-text assertions, so fix + tests land together — no intermediate merged state where one exists without the other.

- [x] T1 — pin `process.env.NODE_ENV` to `"production"` in the chat-react `Bun.build`: add exported `CHAT_REACT_BUNDLE_BUILD_OPTIONS` (with the `define`) to `landing/server.ts`, spread it in `resolveChatReactJs` (options otherwise byte-identical), rewire `landing/__tests__/chat-react-bundle-builds.test.ts` to import it, and add `landing/__tests__/chat-react-bundle-production-runtime.test.ts` building `chat-react/main.tsx` through the SAME imported options and asserting on the built bundle text: `car-conv` present (positive control), `console.createTask` count === 0, `OwnerStack` count === 0, `jsxDEV` count <= 3, with the counts PRINTED. Prove the red side (test fails with ~854/6/7 when the define is temporarily removed) before the green side; both printed count lines go in the PR body.
