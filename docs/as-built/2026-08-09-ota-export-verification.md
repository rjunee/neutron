# An OTA is no longer published without proving the bundle is real

**Landed:** 2026-08-09 · **ISSUES:** #518 · **Surface:** `scripts/eas-update.sh`, `scripts/ci/verify-expo-export.ts`

## What happened

A Metro/Watchman failure produced a broken export and `eas update` **published it
anyway** — exit 0, an update id, a permalink, every signal of success. The OTA
reached the owner's phone dead. Nothing in the pipeline had ever looked at what
was being shipped, and there was no publish wrapper at all: the command was being
run by hand each time.

## Why the obvious check doesn't work

The bundle is Hermes **bytecode**. `grep` for a symbol you know you just added
returns nothing — and reads as "the code is missing" rather than "this tool cannot
read this format". Three wrong diagnoses came out of exactly that during the
original debugging session. A text search over a binary is not a check.

## What it does instead

`verify-expo-export.ts` checks the **format**, not the content:

- `metadata.json` parses, and declares BOTH platforms — one without the other
  strands a device;
- each declared bundle exists on disk;
- each `.hbc` starts with the real Hermes magic `c61fbc03c103191f` — **read off
  this app's own export, not remembered** (bytecode version 96). An HTML error
  page, a truncated write, or plain text under a `.hbc` name all fail here with
  the bytes they actually contained printed in the message;
- each bundle clears an 8 KB floor. A real export is ~2.6 MB, so the floor never
  fires on a genuine shrink but catches a structurally valid stub — the case the
  magic check alone waves through;
- every declared asset exists.

A non-Hermes bundle is legitimate if the app is configured for JSC, so it is
size-checked and **says so** rather than implying it was format-checked.

`scripts/eas-update.sh` splits bundling from publishing: `expo export` → verify →
`eas update --input-dir <verified> --skip-bundler`, so the thing verified is the
thing shipped rather than a second bundling run that could differ. It deletes a
stale `dist` first — otherwise a FAILED export republishes the previous run's
bundle, which is the same silent success this exists to prevent — and refuses
`--branch production` outright.

## Coverage

`scripts/ci/__tests__/verify-expo-export.test.ts` — 10 tests, every one writing a
REAL directory tree, because the failure being guarded is "the bytes on disk are
not what anyone assumed" and a mocked filesystem is the exact layer that would let
a wrong assumption pass. Includes the **positive control**: a well-formed export
must be ACCEPTED, or a reject-everything verifier would pass a suite of
only-negative tests while blocking every real publish. Verified against the live
`app/dist` too — 2.6 MB bundles, magic ok, 27 assets each.

Mutants killed, and they kill **different** tests, which is what shows neither
check is redundant: removing the magic check reds the HTML-error-page case and the
message case; removing the size floor reds the truncated and empty cases.

This is a **publish-time** gate, not a CI gate — CI has no `dist` to inspect.
