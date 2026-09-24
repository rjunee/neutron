## 2026-09-24 — Deterministic test discovery across host locales

The shared test-file discovery helper now sorts its output with the C locale. Its previous inherited-locale `sort` produced a different order under `en_US.UTF-8`, so a host suite could fail the discovery test even though the discovered file set was correct. The byte order also matches the test's expected path order and gives every runner consumer a stable sequence.

The regression fixture runs discovery under both `en_US.UTF-8` and `C`. It verifies the ordered set of all twelve test suffixes, root and nested files, included dot-files, and excluded dependency and dot-directories. With the locale pin removed, the `en_US.UTF-8` case failed on ordering; with the pin present, the focused discovery and runner surface passed (29 tests). Both relevant TypeScript projects and the lint gate passed.

Closes #1280.
