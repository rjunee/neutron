## 2026-09-14 — Persona history and effective prompt inspection (#598)

### What changed and acceptance evidence

The default generator writer and authenticated editor now use the same synchronous
versioned replacement operation: onboarding/persona-gen/compose.ts:384 and
gateway/http/admin-personality-surface.ts:455. Restart preserves the preimage too
(gateway/http/admin-personality-surface.ts:520). The owner-authenticated
`GET /api/app/persona/history?name=SOUL.md` returns ordered full-content versions,
so any two versions can be compared without reconstructing old content
(gateway/http/admin-personality-surface.ts:186; onboarding/persona-gen/history.ts:52).

`/effective-prompt` renders the recorded initial session input and latest dispatch
for the current project/topic, including the harness tool configuration
(gateway/wiring/build-live-agent-turn.ts:1096). The same spec object is recorded
and passed to dispatch, after the cold/warm retry decision
(gateway/wiring/build-live-agent-turn.ts:1618). The initial prompt tells the agent
where to Read that record when asked (gateway/wiring/build-live-agent-turn.ts:2094).
The equality test observes actual substrate.start inputs, checks nonempty tools,
then compares both the stored and chat-rendered values
(gateway/wiring/__tests__/build-live-agent-turn.test.ts:775).

### Stored format and decisions

History is a per-persona-directory SQLite sidecar opened through the sanctioned
openSidecar helper; rows carry monotonic version IDs, filename, observation time,
and nullable content (onboarding/persona-gen/history.ts:25). A persona created
before this change remains the current live file. On first observation or before
its first replacement, its exact bytes become its first observed version. Its
original generation time is unknown; observed_at does not invent that time.
Missing files become NULL, empty files become an empty string, and populated
files retain their bytes. Read errors other than ENOENT throw instead of becoming
missing (onboarding/persona-gen/history.ts:14). Migration tests enumerate all
three legacy shapes and then revisit already-versioned rows to prove idempotence
(onboarding/persona-gen/__tests__/history.test.ts:15).

Identical observed content is deduplicated; versions describe changed content,
not a count of save requests (onboarding/persona-gen/history.ts:47). The preimage
is stored before replacement; current bytes are recorded after atomic rename
(onboarding/persona-gen/history.ts:59). These synchronous writes maintain the
ordering independently of cache invalidation hooks or an agent remembering to
save history. The three persona files remain independent replacement units,
matching the generator's existing per-file writes
(onboarding/persona-gen/compose.ts:274).

Prompt records have format_version=1 and validate the observation time and spec
shape; corrupt/unsupported records throw, and only ENOENT means no record
(gateway/wiring/effective-prompt.ts:23). Warm records retain the initial session
spec; an unobserved initial session is explicitly null. Cold dispatch replaces
old context (gateway/wiring/effective-prompt.ts:42). Inspection is queued instead
of injected into an active model turn (gateway/wiring/build-live-agent-turn.ts:977).

### Outcome vocabulary and guard delivery

History read failures use the surface's JSON error vocabulary (`read_failed`,
HTTP 500); edits retain `write_failed`, and regeneration retains `commit_failed`
(gateway/http/admin-personality-surface.ts:194, :459;
onboarding/persona-gen/compose.ts:278). The app client preserves server codes and
messages rather than treating unknown codes as success
(app/lib/admin-personality-client.ts:159).

Prompt capture failures join the existing failed-turn vocabulary. Its default
branch would display a connection message, so `prompt_capture_failed:` has an
explicit storage-failure branch before auth/timeout classification; dispatch is
refused when recording fails (gateway/wiring/effective-prompt.ts:55;
gateway/wiring/build-live-agent-turn.ts:1721). Inspection distinguishes missing
records from unreadable records (gateway/wiring/build-live-agent-turn.ts:1099).

These are runtime writer/dispatch guards, not optional maintenance scripts.
Their regression tests are ordinary discovered .test.ts files; CI invokes the
partitioned test runner (.github/workflows/ci.yml:437), whose discovery list is
consumed at scripts/run-tests.sh:240.

### Mutation results

Each mutation was applied alone. Before each test run, its actual landing line
and the diff against the restored file were printed. Every row below went RED
under mutation and GREEN after restoration. Test names identify the failing
fixture; paths are the five focused files listed in Validation.

| Guard or wiring | Mutation | Failing test | Restored |
| --- | --- | --- | --- |
| onboarding/persona-gen/history.ts:60 preimage | remove initial snapshot | edit imports the legacy preimage | GREEN |
| onboarding/persona-gen/history.ts:47 deduplication | always insert | migration preserves legacy | GREEN |
| onboarding/persona-gen/history.ts:19 unknown read | treat every open error as missing | a symlink is an unknown read | GREEN |
| onboarding/persona-gen/history.ts:17 no-follow read | remove O_NOFOLLOW | a symlink is an unknown read | GREEN |
| onboarding/persona-gen/history.ts:74 deletion preimage | remove snapshot | restart snapshots an external edit | GREEN |
| onboarding/persona-gen/history.ts:68 cleanup | rethrow expected ENOENT | migration preserves legacy | GREEN |
| onboarding/persona-gen/compose.ts:384 generator wiring | replace with unversioned Bun.write | commit writes 3 files | GREEN |
| gateway/http/admin-personality-surface.ts:455 editor wiring | replace with unversioned Bun.write | editor history preserves pre-versioning bytes | GREEN |
| gateway/http/admin-personality-surface.ts:188 filename allowlist | disable check | editor history preserves pre-versioning bytes | GREEN |
| gateway/wiring/effective-prompt.ts:48 initial context | overwrite with warm spec | cold, warm and reset retain exact dispatch inputs | GREEN |
| gateway/wiring/effective-prompt.ts:32 unknown read | treat every error as missing | unknown session start stays unknown | GREEN |
| gateway/wiring/effective-prompt.ts:26 format version | remove version check | unknown session start stays unknown | GREEN |
| gateway/wiring/effective-prompt.ts:39 spec validation | accept invalid arrays | record schema rejects malformed specs | GREEN |
| gateway/wiring/effective-prompt.ts:19 project boundary | omit project from key | project and topic boundaries produce distinct paths | GREEN |
| gateway/wiring/effective-prompt.ts:44 cold recovery | read corrupt prior record on cold turn | cold dispatch replaces an unreadable old record | GREEN |
| gateway/wiring/build-live-agent-turn.ts:1619 capture | remove recording | effective prompt view renders the exact cold and warm runtime dispatch | GREEN |
| gateway/wiring/build-live-agent-turn.ts:1721 error classification | disable storage branch | prompt capture failure prevents dispatch | GREEN |
| gateway/wiring/build-live-agent-turn.ts:2094 agent discovery | remove instruction | effective prompt view renders the exact cold and warm runtime dispatch | GREEN |
| gateway/wiring/build-live-agent-turn.ts:977 injection boundary | remove interception | inspection queues behind an active turn | GREEN |

The first version-check mutation survived: the fixture also failed the remaining
schema predicates, so removing that one predicate could not admit it. An otherwise
valid record with only an unsupported format version now reaches that specific
guard (gateway/wiring/__tests__/effective-prompt.test.ts:32). The concurrency
fixture initially included an unrelated ordinary message and incorrectly expected
it not to be injected. The final fixture isolates inspection during an active
turn and requires zero injections (gateway/wiring/__tests__/build-live-agent-turn.test.ts:815).

### Validation

Final focused run: **49 passed, 0 failed**, 180 assertions. Files explicitly
passed to bun test (this enumerates the tested set):

- onboarding/persona-gen/__tests__/history.test.ts
- onboarding/persona-gen/__tests__/compose-roundtrip.test.ts
- gateway/wiring/__tests__/effective-prompt.test.ts
- gateway/http/__tests__/persona-history.test.ts
- gateway/wiring/__tests__/build-live-agent-turn.test.ts

Local lint passed. The 51-config typecheck matrix failed, and a separate root
`bunx tsc --noEmit` run reproduced errors at
`gateway/transcription/__tests__/whisper-install.test.ts:186`,
`logger/__tests__/fire-and-forget.test.ts:301`, and
`onboarding/history-import/__tests__/zip-writer.ts:10`.
The app config also reported a missing @types definition. Those files are
unchanged: a scoped `git diff HEAD --` over those three files plus the changed
onboarding/persona-gen/compose.ts reported only the latter as a positive control.
The existing admin-personality-surface HTTP tests could not bind port 0 in this
sandbox; the added history HTTP test invokes the production handler directly.
These failures were not skipped, weakened, or reported as green.
The leak gate returned INCOMPLETE: zero findings from executed rules, but the
external PII denylist was unavailable, so its two rules could not run.

### Deliberate limits

This records the harness dispatch boundary, not provider-internal instructions
or a provider's entire accumulated transcript (runtime/substrate.ts:50;
gateway/wiring/effective-prompt.ts:45). History belongs to committed persona
files, not uncommitted onboarding drafts. Direct external edits are observed at
the next history read/write; edits that are overwritten externally before any
observation cannot be recovered (onboarding/persona-gen/history.ts:42).
A process interruption after rename is recovered by the next observation of the
live file, while the old preimage was already stored; this is not a transaction
across SQLite and all three files (onboarding/persona-gen/history.ts:60).

No retention pruning, restore button, editor redesign, provider adapter rewrite,
or unrelated type/dependency fixes were included. No SPEC decision was changed.
The record is staged under the build-lane-requested .trident path rather than
adding a second copy under docs/as-built.
