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
- `channels/adapters/telegram/client.ts` — `getFile`, `downloadFile` (capped by
  declared and actual length), `sendFile` (`sendPhoto` / `sendVideo` /
  `sendDocument` as multipart), `sendMediaGroup`, `sendChatAction`, over a shared
  `callMultipart`.
- `channels/adapters/telegram/access.ts` — the access list in
  `<NEUTRON_HOME>/telegram/access.json`: allowed users, connected chats with their
  project id, the default project, pairing codes (six characters, one hour, one
  per person, at most five outstanding). Malformed content reads as an empty list.
  Writes are atomic, mode 0600.
- `channels/adapters/telegram/reply-files.ts` — `[[file: /absolute/path]]` lines
  in a reply, classification into photo / video / document, album planning, and
  4096-character chunking that never splits a surrogate pair.
- `open/wiring/telegram-chat.ts` — the bridge: commands (`/start`, `/pair`,
  `/connect`), the delivery rule (allowed sender AND connected chat), downloads
  into `<NEUTRON_HOME>/telegram/inbox/<chat>/`, transcription with a `.txt` beside
  the audio, album gathering (1.5 s window), de-duplication by `<chat>:<message>`,
  the turn on `appWsProjectTopicId(owner, project)` through the same live-agent
  runner the web chat uses, and the reply back to the chat. The webhook returns
  before the turn runs.
- `open/composer.ts` — the voice-note transcriber the upload route used inline is
  now one named function (`transcribeVoiceNote`) shared by the upload route and
  the bridge; the Telegram surface gets a late-bound receiver that forwards to the
  bridge. `gateway/wiring/build-telegram-webhook.ts` returns the `client` with the
  surface.

### Turn shape

```
[telegram chat=<chat_id> from="<display name>" user=<user_id> msg=<message_id>]
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
- Replies to a Telegram turn are not copied into the web chat transcript; the
  turn itself is part of the project session's history.

### Tests

`open/__tests__/telegram-chat-bridge.test.ts` drives the real webhook handler,
decoder, `TelegramClient` and access file against a local Bun server speaking the
Bot API (strangers dropped with zero API calls, pairing a second member,
connecting a group, photo and voice downloads, album gathering, file replies,
de-duplication, no-agent message). Unit tests:
`channels/adapters/telegram/__tests__/access.test.ts`, `reply-files.test.ts`,
`webhook-media-decode.test.ts`. The existing Telegram tests pass unchanged.
