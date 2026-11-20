## 2026-11-20 — Ogg/Opus voice notes go through ffmpeg

`gateway/transcription/local-whisper.ts` sends `audio/ogg` through ffmpeg (16 kHz
mono wav) whenever ffmpeg is installed. `whisper-cli`'s miniaudio decodes Ogg
Vorbis but not Ogg Opus, which is what every Telegram voice note is, so on a box
with local transcription each voice note failed with `exec_failed` ("failed to
read audio data") and reached the session with no transcript. Without ffmpeg an
Ogg file still goes to whisper directly. Tests:
`gateway/transcription/__tests__/local-whisper.test.ts` (ogg with and without
ffmpeg).
