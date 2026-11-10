---
title: Telegram group chats reach a project session with pairing and media
group: platform
status: done
priority: P2
cutover: false
---

An instance with a Telegram bot can be used from a plain Telegram group shared by
several people (for example two parents), not only from the web chat. Messages
from the group reach the warm session of one project and the agent's reply comes
back to the group, including files.

Before this item the webhook decoded text messages only, from any chat, and handed
them to a router whose topic handler was a no-op, so nothing reached an agent.

## Behaviour

- **Access list.** `<NEUTRON_HOME>/telegram/access.json` holds the allowed users,
  the connected chats (each bound to a project id), the default project for new
  connections, and outstanding pairing codes. The operator seeds the first allowed
  user and the default project; the file is re-read on every message.
- **Delivery rule.** A message reaches an agent only when its sender is allowed
  and its chat is connected. Anything else is dropped with no reply and no
  download.
- **Pairing.** `/start` in a private chat from a person not yet allowed returns a
  six-character code that lives one hour. `/pair <code>` from an allowed user, in
  a connected chat or a private chat, admits that person. `/start` in a group
  never shows a code. `/pair` and `/connect` from a stranger get no answer.
- **Connecting a group.** `/connect` from an allowed user inside a group connects
  it to the default project. With Telegram's default group privacy a bot sees
  only commands, so the reply to `/connect` warns unless the bot can read every
  group message (privacy off in BotFather, or the bot is a group admin).
- **Rate limit.** With the access list wired, updates from senders who are not on
  it are counted in their own bucket, so a stranger flooding the bot cannot use up
  the budget of the people it serves.
- **Media.** Photos (largest rendition), voice notes, audio, documents and videos
  are downloaded after the access check into
  `<NEUTRON_HOME>/telegram/inbox/<chat>/`, capped at the Bot API's 20 MB. The
  items of one album become one turn.
- **Voice.** Voice notes and audio are transcribed with the same transcriber the
  web chat's uploads use (the owner's Settings choice; local whisper.cpp honours
  `NEUTRON_WHISPER_BIN` and `NEUTRON_WHISPER_MODEL`). A voice note without a
  caption reads `[voice] <transcript>`.
- **The turn.** The turn runs on the project's web-chat topic, so a project has
  one warm session whichever surface a message came from. Its text is a header
  line `[telegram chat=<id> from="<name>" user=<id> msg=<id>]`, a one-line note
  telling the agent the reply goes to the chat and how to attach files, then a
  `<user_attachments>` block of local paths when files came with it, then the
  words.
- **The reply.** The agent's reply is posted to the chat it came from, split at
  4096 characters. A reply line `[[file: /absolute/path]]` is posted as a photo,
  video or document; two or more consecutive photos and videos go out as one
  album; at most 10 files, 50 MB each. A file that cannot be sent is reported in
  the chat.
- The webhook answers Telegram before the turn runs, and a re-sent update runs
  once.

## Acceptance

- [x] A stranger's message in a connected group produces no turn, no download and
      no Bot API call.
- [x] `/start` in a private chat issues a code; `/pair <code>` from an allowed
      member admits a second member, whose next message reaches the session.
- [x] `/connect` by an allowed member connects a group to the default project;
      nothing is delivered from a group before that.
- [x] A photo arrives as a local file listed in the turn; a voice note arrives as
      `[voice] <transcript>` with its local path and a `.txt` transcript beside it.
- [x] An album is one turn.
- [x] The turn's topic is the project's web-chat topic.
- [x] A reply with `[[file: …]]` lines posts its text, then a document and a
      video; two photos go out as one album.
- [x] An instance with no Telegram secrets mounts no route and builds no bridge.
- [x] A stranger sending many updates does not stop an allowed member's messages.
- [x] `/connect` warns when the bot cannot read ordinary group messages.

Tests: `open/__tests__/telegram-chat-bridge.test.ts` (end to end through the
webhook handler against a local mock of the Bot API),
`channels/adapters/telegram/__tests__/{access,reply-files,webhook-media-decode}.test.ts`.
