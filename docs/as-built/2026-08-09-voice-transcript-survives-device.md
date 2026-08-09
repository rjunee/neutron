# A voice note's words survive the device

## The correction

The earlier half of this fix (#158) returned the transcript on the upload response so the
uploading device could index it locally. **It shipped on a belief that turned out to be
false: that a user's own messages are not persisted server-side.**

They are. `app_chat_messages` holds user rows — on a live instance, 42 user rows beside
124 agent rows, 13 of them carrying attachments — and `replayAfter` is how a reconnecting
or freshly-installed device rebuilds its history from them.

**So the fix worked only on the phone that happened to perform the upload.** On a new
device, after a reinstall, or after a local database is cleared, the voice notes came
back with their audio and none of their words: unsearchable again, permanently, with
nothing to indicate anything was missing. The owner caught it by questioning the sentence
rather than the code.

## What changed

Migration `0117` adds a nullable `transcript` column to `app_chat_messages`; the store
persists and returns it; the replay envelope carries it; the client applies it on inbound
and merges it without ever regressing a known value to null.

**The server resolves the transcript itself rather than accepting it from the client.**
The text already exists on this machine — the upload writes a content-addressed sidecar
beside the audio — so asking the client to send it back would be a round trip of data we
already hold, and would let any client write arbitrary text into a field that is indexed
and read by the agent. The resolver is the same seam the scribe path already uses; the
client's copy exists only for its own local index.

**Not `meta_json`.** That column exists and is already carried through append and replay,
which makes it the tempting answer. It is documented as agent-message presentation
metadata and as "always null for user messages", and the replay envelope's user branch
does not read it at all. Putting a user message's most important text in a field whose
contract says it is never populated for user messages is the quiet overload that reads as
correct for a year and then produces a bug nobody can locate.

**Not backfilled.** The sidecars for existing audio are still on disk, so a sweep is
possible — but it would have to walk the blob store and re-associate by content hash,
which is a far larger blast radius than adding a column. Existing voice notes behave
exactly as they do today; new ones are searchable everywhere. A backfill is a separate,
reversible tool if it is ever wanted.

## Verification, and what the mutants exposed

`channels/adapters/app-ws/__tests__/voice-transcript-survives-device.test.ts` (11) and
five new cases in `persistence/app-chat-store.test.ts` (20 total).

**Four mutants. The first pass killed only one of them, and that is the useful part:**

| mutant | first pass | after |
|---|---|---|
| replay drops the transcript | **caught** | caught |
| the column is never written | **survived** | caught by 3 tests |
| the server never resolves it from the sidecar | **survived** | caught by 2 tests |
| the composer never wires the seam | **survived** | caught |

The last one is the defect shape `SPEC.md` names as this repo's repeat offender — the
module correct, its tests passing, and the composer never connecting it. Every other test
in the file stayed green while the feature was dead. Its guard asserts against the real
composer's source, scoped to the adapter construction rather than the whole file, because
the resolver's name also appears in the scribe path and an unscoped match would pass on
that alone.

Typecheck matrix 51/51 (the row type gained a required field, so two existing fixtures
were updated rather than the field being made optional — an optional row field would have
let a decoder silently omit it). Schema snapshot regenerated; migration runner's expected
list extended. Byte-scanned for control characters. Leak gate silent on every changed
file.

## Also in this change: two arbiter design docs

`docs/plans/2026-08-09-multi-substrate-build-agent.md` and
`docs/plans/2026-08-09-model-usage-dashboard.md`. Both are design recommendations awaiting
owner decisions, not implementation. The first resolves a question that had been treated
as settled: a Codex build turn **cannot** commit under `workspace-write`, by deliberate
policy rather than by accident of the worktree layout — so the recommendation is that the
harness commits and the model only edits, which removes the full-access question instead
of mitigating it.
