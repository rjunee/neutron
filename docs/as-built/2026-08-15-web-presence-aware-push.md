## 2026-08-15 — the gateway had no idea whether he was looking, and the two ways to fake it both end in silence

Landed via PR #305. The owner: *"can you also check if I'm actively using the web app, and if so dont
send push notifications to my phone."* One feature, and the whole of it is about the failure mode
rather than the happy path.

**THE OBVIOUS IMPLEMENTATION WAS ALREADY ARGUED DOWN, IN A COMMENT, ABOUT THE OTHER CLIENT.** "Skip
the push when a socket is open" is refused above the notify in `gateway/http/deliver.ts`, because
Android keeps the app-ws socket open while the app sits in the background — so gating on
`delivered_live` would silence exactly the case a notification exists for. A browser tab holds its
socket the same way. The comment was about mobile and the reasoning is client-independent, which is
why re-deriving it for the web would have produced the same bug with a different name.

**AND THE SIGNAL EXISTED ON THE CLIENT, UNSENT, FOR THE WHOLE TIME.** `chat-core/ws-client.ts`
`setActive` is wired to `document.visibilityState` and does nothing with it but start and stop its own
heartbeat. It has never sent a byte to the server. 📌 **A client that ALREADY SUBSCRIBES to the signal
you need is the most convincing wrong answer available** — the wiring is right there, it reads as
plumbed, and nothing about `setActive(false)` says "the server was never told".

**THE REPEAT IS NOT THE HEARTBEAT, AND THAT IS THE ONE DESIGN CHOICE MOST LIKELY TO BE UNDONE BY A
LATER SIMPLIFICATION.** Presence is level-triggered with a TTL, so a foregrounded tab has to keep
saying so, and the heartbeat is sitting right there already sending frames on a timer. It cannot be
used: the heartbeat is IDLE-driven — every inbound frame reschedules it — so it goes quiet on a socket
carrying a streaming agent reply, which is precisely the moment the owner is watching the answer he is
about to be pointlessly notified about. A dedicated unconditional timer, and a comment at both ends
saying why.

**EVERY UNCERTAIN CASE NOTIFIES, BECAUSE THE OTHER FAILURE IS INVISIBLE.** Wrong in one direction is a
redundant buzz he notices in seconds; wrong in the other is silence, which produces no push, no error
and nothing on any screen — a browser killed by a crash or a hard lid-close sends no close frame at
all. So: presence expires on its own; an unknown owner, an empty tracker and a THROWING presence check
all read as not-present; the decoder refuses an unrecognised `state` rather than reading "not
background" as present; and a suppressed push answers `false` so the durable row is never stamped
`delivered_at` and a later re-emit is still free to buzz him.

**THE TTL IS DERIVED FROM THE REFRESH, NOT WRITTEN BESIDE IT** (`wire-types/web-presence.ts`). Two
hand-kept numbers on opposite sides of a socket is the `~general` / `#general` / `general` shape of
ISSUES #410/#411 waiting to happen, and here the drift is asymmetric: a TTL that is too SHORT is a
duplicate buzz, a client that stops refreshing against a server that never expires is permanent
silence. One number, one hop above both sides.

**A MUTATION SURVIVED, AND THE TEST IT SURVIVED WAS THE ONE NAMED AFTER THE PROPERTY.** Presence is
keyed on a per-socket `conn_id` rather than `device_id`, and `two tabs are two connections` asserted
exactly that — except both clients in it connected without a `device_id`, so the server minted a
distinct one per connection and `conn_id: device_id` changed nothing observable. The property the key
actually buys is the SHARED-id case (`device_id` is client-supplied and treated as stable across
reconnects), which nothing drove. 📌 **A test can be named after the mechanism and fixtured around a
case where the mechanism does not matter** — and a mutation is the only thing that tells you, because
the test's name reads as coverage and its green reads as proof.

**THE DOCBLOCK BESIDE IT WAS ASPIRATIONAL IN THE SAME BREATH.** It justified the per-connection key by
asserting that "two browser tabs can present the same value" — but `landing/chat-react/config.ts`
`makeDeviceId` mints one per page load, so no current client does. The hazard is real and the
justification for it was a mode nothing enters, stated as though it were the observed reason. Rewritten
to say what is load-bearing (the field's contract, not one client's behaviour) and to point at the test
that drives it.

**A `git` ANCESTRY QUESTION RETURNED A FALSE ANSWER FROM A SHALLOW CLONE, AGAIN.** The pre-push leak
gate resolves its scan window as `origin/main..HEAD`, and that came back as 268 commits — the whole
history — so it flagged 206 findings in commit messages written months ago. The cause was not the gate:
`.git/shallow` had reappeared on the checkout, `git log origin/main` returned exactly ONE commit, and
`merge-base --is-ancestor` answered NOT-ancestor for a commit that plainly was one. `git fetch
--unshallow` took it to 268 real commits and the window collapsed to 54 lines, SILENT. 📌 **This trap is
already written down and it re-armed itself**: the fix is not durable, because any later fetch with a
depth re-shallows the clone. Treat a `git` answer that disagrees with the forge API as a clone problem
until proven otherwise — asking the API for the commit's parents showed the parent the local object
store simply did not have.

**AND THE ONE THAT ACTUALLY COST THE TIME: A GREEN LOCAL SUITE, A GREEN THREE-OF-FOUR CI, AND A BUNDLE
THAT WOULD NOT BUILD.** CI's `shard 3/4` failed with `GET /chat-react.js → 404` — the web chat client
serving nothing at all — while the identical build PASSED in shard 4 of the same run, on the same
commit. Everything about that reads as a flake, and it was not one.

**A 404 IS NOT A DIAGNOSIS, AND THE CODE MADE SURE IT COULD NEVER BE ONE.** `landing/server.ts`
`resolveChatReactJs` returns null when `Bun.build` fails and routes the bundler's own logs to the
system-event journal — which no CI log shows. So the only evidence a broken web client leaves in CI is
a status code. The first real step was a test that runs the same build and PRINTS `result.logs`
(`landing/__tests__/chat-react-bundle-builds.test.ts`); it named the file in one run.

📌 **When a failure's only symptom is a status code, the first fix is not to the code — it is to make
the failure say its own name.** The journal is the right home for a production degrade row and the
wrong home for a CI diagnostic, and nothing had noticed because the build had never failed before.

**THE MEASUREMENT, once it could be reproduced** (`NEUTRON_TEST_SHARD=3/4 … bash scripts/run-tests.sh`
reproduces it locally; the isolated file never does):

| tree | 100-file chunk | browser bundle |
|---|---|---|
| this branch, value import of the shared leaf from `chat-core/web-session.ts` | same 100 files | **FAILS** — `No matching export in "wire-types/web-presence.ts"` for exports that are plainly in the file |
| this branch, that import removed | same 100 files | passes |
| this branch, the SAME leaf value-imported from `landing/chat-react/config.ts` instead | same 100 files | passes |
| untouched base commit | same 100 files | passes |

`chat-core` had imported `@neutronai/wire-types` only as a TYPE — erased, no runtime edge. Making it a
VALUE import put the leaf into the browser graph through `chat-core`'s own
`node_modules/@neutronai/wire-types` link, and under a loaded `bun test` process `Bun.build`
intermittently reported the module as having no exports. Not a resolution failure (the file reads fine
through that symlink), not file content (the same bytes bundle in another shard), and not a file-descriptor
limit (reproduced at `ulimit -n 48` without failing).

**THE FIX KEEPS THE INVARIANT THE PACKAGE ALREADY HAD** rather than working around the symptom:
`chat-core` stays free of runtime dependencies on `wire-types`. The frame is written as a literal under a
TYPE-ONLY `AppWsInboundPresence` annotation — so the compiler still enforces ONE wire shape with no
runtime edge — and the refresh cadence is a local `DEFAULT_PRESENCE_REFRESH_MS` pinned equal to
`WEB_PRESENCE_REFRESH_MS` by a test. A test may import both freely; a test is not bundled for a browser.

📌 **A duplicated constant is acceptable exactly when an assertion makes the duplication impossible to
drift — and unacceptable when the argument for sharing it is "one source of truth" alone.** This file
argued that case for the TTL two hours earlier and it was right there; it is still right, and the
mechanism that enforces it is now an equality test instead of an import, because the import had a cost
the argument had not priced.

📌 **THREE SHARDS GREEN AND ONE RED IS A SIGNAL, NOT NOISE — and the sharding itself is what made it
look like noise.** Adding four test files shifted every file's index, which moved the bundle-building
test between shards run to run; that is why the same failure looked like it "moved around" and why it
was tempting to call it flaky. The discriminator was never the shard: it was whether the bundle got
built inside a loaded chunk at all.
