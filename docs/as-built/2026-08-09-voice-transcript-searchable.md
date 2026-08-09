# A spoken word is findable in chat search

## The gap

A voice note was transcribed at upload, the text was written durably beside the audio,
and the memory pipeline received it. **Search could not see any of it.** The search
index mirrors the message `body`, and a voice note's body is the attachment
placeholder. Nothing was lost and nothing was findable — the owner's words were in the
system and unreachable from the one surface built for reaching them.

Owner: *"I don't want to lose my voice chat messages in opaque binary blobs."* They
weren't opaque. They were just invisible to search.

## The shape of the fix

**The transcript rides back on the UPLOAD RESPONSE.** A user's own message is never
persisted server-side — only agent messages get a durable row — so the client owns it,
and the upload response is the only point at which the client can learn the transcript
without a second round trip or a new frame. It stamps it on the message it is about to
send, and its local store indexes it.

**`transcript` is a field of its own, not appended to `body`.** The body is what
renders; appending would change how every existing voice note displays and duplicate
text the agent's turn already carries separately. So `body` stays the display text,
`transcript` is indexed alongside it, and each has exactly one writer.

Both search implementations were updated, because two independent searches over one
data model is the classic place a field gets indexed on one platform and not the other:
the durable FTS5 mirror gains a second indexed column, and the in-memory path matches
against `body + transcript` through a **single shared `searchableText`** so "what is
searchable" has one definition.

## Two details that would each have produced a working-but-useless search

**`snippet(tbl, -1, …)`, not column 0.** FTS5 reads a negative column index as "the
column with the most matches". Pinned at `body`, a voice-note hit would render the
unhighlighted placeholder — a result the owner cannot recognise. The search would pass
every "does it return the row" test and be useless in the hand.

**The idempotent re-upload path must READ the sidecar.** It deliberately does not
re-invoke the ASR seam, so returning only what *this* call transcribed would make the
same audio searchable the first time and silently not the second. That reads as a flaky
feature rather than an absent one, which is harder to diagnose than never working.

## The migration is the risky half

An FTS5 table cannot gain a column, so an existing single-column index must be dropped,
recreated and **rebuilt** — and the triggers go with it, because they were compiled
against the old column list and an `IF NOT EXISTS` recreate would leave the old ones in
place, silently out of step with the schema they mirror.

The FTS DDL was **split out of the main `SCHEMA` array** so the column migration runs
first: the triggers name `new.transcript`, which does not exist on a database written by
an older build. Creating them in the same pass would work on a fresh install and fail on
every upgrade — the asymmetry that makes a migration bug invisible in development.

The rebuild is detected from the stored DDL in `sqlite_master`, not by probing a query:
a `MATCH` against a missing column throws the same way a dozen other faults do, and a
rebuild triggered by the wrong error would discard a healthy index.

## Verification

`app/__tests__/voice-transcript-searchable.test.ts` (14, against a real bun:sqlite FTS5
engine) and four new cases in `gateway/__tests__/app-upload-surface.test.ts` (36 total).
The upgrade path is tested against a **hand-built pre-fix schema** — the state on every
phone that has ever run the app — including that a second open is idempotent and that
pre-existing messages stay findable.

**Four mutants, each killed by a different test:** pinning the snippet to column 0;
dropping the index without backfilling; making in-memory search ignore the transcript;
and skipping the sidecar read on the idempotent upload path.

Typecheck matrix 51/51. Lint clean. Byte-scanned for control characters (the NUL
incident earlier the same day). Leak gate silent on every changed file.
