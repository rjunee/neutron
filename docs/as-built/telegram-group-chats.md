## 2026-11-10 — Telegram group chats reach a project session, with pairing, media and voice

Spec item: `docs/spec-items/telegram-group-chats.md`.

The Telegram webhook (`POST /webhook/telegram`, mounted only when the instance's
SecretsStore holds the bot token, webhook secret and bot user id) now hands every
decoded update to a chat bridge instead of a router whose topic handler did
nothing. With no Telegram secrets the route, the client and the bridge are all
absent, as before.

### What changed

- `channels/adapters/telegram/webhook-server.ts` — `decodeUpdate` accepts media
  messages. A message with text decodes exactly as before. A message with a photo
  (largest rendition), voice note, audio, document, video or video note carries
  `TelegramAttachmentRef` entries in `body.attachments` and its caption as text.
  A message with neither text nor a file (a sticker) is still ignored. Every event
  now carries `adapter_metadata` `{chat_id, chat_type, message_id, chat_title?,
  media_group_id?, edited?}`.
- `channels/adapters/telegram/webhook-server.ts` also takes an optional
  `is_known_sender`; when set (the composer passes the access list), updates from
  senders not on the list are rate-limited in their own bucket, charged after the
  body is parsed; a body that does not parse is charged to that bucket too. Without it the single bucket is charged before parsing, as
  before.
- `channels/adapters/telegram/client.ts` — `getFile`, `downloadFile` (reads the
  stream and stops past the cap, whatever `Content-Length` says), `getChatMember`, `sendFile` (`sendPhoto` / `sendVideo` /
  `sendDocument` as multipart), `sendMediaGroup`, `sendChatAction`, over a shared
  `callMultipart`.
- `channels/adapters/telegram/access.ts` — the access list in
  `<NEUTRON_HOME>/telegram/access.json`: allowed users, connected chats with their
  project id, the default project, pairing codes (six characters, one hour, one
  per person, at most five outstanding). Malformed content reads as an empty list
  (nobody allowed), and a file that is not a JSON object is never overwritten: a
  change against it is refused, so an operator's half-saved edit keeps its users
  and chats. Writes are atomic, mode 0600.
- `channels/adapters/telegram/reply-files.ts` — `[[file: /absolute/path]]` lines
  in a reply, classification into photo / video / document, album planning, and
  4096-character chunking that never splits a surrogate pair.
- `open/wiring/telegram-chat.ts` — the bridge: commands (`/start`, `/pair`,
  `/connect`), the delivery rule (allowed sender AND connected chat), downloads
  into `<NEUTRON_HOME>/telegram/inbox/<chat>/`, transcription with a `.txt` beside
  the audio, album gathering (1.5 s window), de-duplication by `<chat>:<message>`,
  the turn on `appWsProjectTopicId(owner, project)` through the same live-agent
  runner the web chat uses, and the reply back to the chat. The webhook returns
  before the turn runs. Recent update ids are kept in
  `<NEUTRON_HOME>/telegram/seen-updates.json` (last 1000), so a re-sent update
  runs once across a restart. A message written in a forum topic is answered in
  that topic. `/connect` checks `getMe.can_read_all_group_messages` and the bot's
  membership status and warns in the chat when the bot would see only commands. A project with no model that can answer gets the same "no AI
  credential" message as the web chat (`canDispatchLiveAgent`). Transcripts are cut at 4000 characters, and a captionless voice
  note's transcript appears once, as the `[voice]` line. Reply files are read one
  upload at a time and capped at 100 MB per reply. At shutdown the bridge drains
  first, from the composition's `on_shutdown_start` (before the persistent REPLs
  stop): it starts the turn for an album still being gathered and waits up to
  10 s for running turns. A reply that offers choices (`options`) is posted with
  them as a numbered list, and a bare answer to the next message ("2",
  or the choice's words) is sent as that choice's value, as a button tap would
  be. Turns run one after another per chat in arrival order: an album takes its
  place in the queue at its first item, so a follow-up never reaches the session
  ahead of the photos or voice note it refers to.
- `gateway/wiring/build-live-agent-turn.ts` and
  `gateway/http/chat-sender-registry.ts` — a turn request may name its
  `reply_sink` (absent = the web chat). A follow-up is injected into the topic's
  active turn only when both reply to the same sink; otherwise it queues behind
  it. Telegram turns carry `telegram:<chat_id>[:<forum topic>]`, so a family message arriving
  while a web-chat or timer turn runs is answered in the family chat, not in the
  web chat. Web-chat turns inject into each other exactly as before.
- `open/composer.ts` — the voice-note transcriber the upload route used inline is
  now one named function (`transcribeVoiceNote`) shared by the upload route and
  the bridge; the Telegram surface gets a late-bound receiver that forwards to the
  bridge. `gateway/wiring/build-telegram-webhook.ts` returns the `client` with the
  surface.

### Turn shape

```
[telegram chat=<chat_id> from="<display name>" user=<user_id> msg=<message_id>]
(Your reply goes to this Telegram chat. To send a file with it, put each file on its own line of the reply as [[file: /absolute/path]]; …)
<user_attachments>
…one line per local file; audio lines carry the transcript…
</user_attachments>
<the words, or "[voice] <transcript>" for a voice note with no caption>
```

### Not done here

- Nothing calls `setWebhook` or writes the three Telegram secrets into an
  instance's SecretsStore; provisioning a bot stays with whoever hosts the
  instance.
- A group upgraded to a supergroup gets a new chat id and has to be connected
  again with `/connect`.
### History

Telegram turns and their replies are part of the project's chat history, so they
show in the web chat for that project (it is one session). Replies to web-chat
turns are not sent to Telegram. The turn runs as the instance owner (Open is
single-owner, and the warm session is keyed on the owner), so the stored row's
speaker is the owner; who actually wrote the message is the header line's
`from=` and `user=`, which is stored with the text.

### Tests

`open/__tests__/telegram-chat-bridge.test.ts` drives the real webhook handler,
decoder, `TelegramClient` and access file against a local Bun server speaking the
Bot API (strangers dropped with zero API calls, pairing a second member,
connecting a group, photo and voice downloads, album gathering, file replies,
de-duplication, no-agent message). Unit tests:
`channels/adapters/telegram/__tests__/access.test.ts`, `reply-files.test.ts`,
`webhook-media-decode.test.ts`. The existing Telegram tests pass unchanged.
