/**
 * @neutronai/app — recording a voice message, from the mic to the wire.
 *
 * THE GAP THIS FILE CLOSES. Voice messages shipped as five green modules and
 * zero reachable feature: the recorder, the overlay, the upload orchestration
 * and the gesture arithmetic all had passing unit tests, and nothing in the app
 * ever called any of them. Pressing the mic said "Voice messages are not
 * available yet." Every test in the repo agreed everything was fine.
 *
 * So the assertions here are deliberately end-of-chain. They start at the
 * control the owner actually touches — pressed by its accessibility label on a
 * REAL mounted `ChatSyncSurface`, with the real composer, the real recorder
 * hook, the real upload client and the real send queue — and they finish at the
 * `user_message` frame leaving the socket with the clip's URL on it. Nothing in
 * between is stubbed except the two things that cannot exist in a test process:
 * the native microphone (`support/stubs/expo-audio.ts`) and the network.
 *
 * WHAT THIS FILE STILL CANNOT SEE — and it is the reason a device check is not
 * optional: the OS permission sheet, real capture, real audio in the file, the
 * long-press gesture as a finger performs it, and anything Hermes does
 * differently. See `support/native-harness.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { harnessAudioState, resetHarnessAudio, setHarnessAudio } = await import(
  './support/stubs/expo-audio'
);
const { MIN_RECORDING_MS } = await import('../lib/voice-recording');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';
/** What the gateway hands back for an accepted clip. */
const UPLOADED_URL = '/api/app/upload/harness-owner/deadbeef.m4a';

// ── The network, faked at XMLHttpRequest ──────────────────────────────────────
// `uploadAttachment` takes the XHR branch wherever `XMLHttpRequest` exists (it
// wants byte progress), and happy-dom provides one. Replacing the constructor is
// therefore the whole of the network stub — the upload client itself runs real.

interface FakeXhrRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * React Native's `FormData` accepts `{ uri, name, type }` as a file entry — that
 * is how an Expo app uploads a `file://` clip without ever reading its bytes,
 * and it is the branch `buildMultipartBody` takes for a recording. Bun's
 * spec-compliant `FormData` rejects a non-`Blob` third argument outright, so
 * with the real one in place the upload dies before it reaches the network and
 * the test would be proving nothing about the device's code path.
 *
 * This stands in for the RN implementation so the REAL branch runs. It also
 * keeps the entry, so what was attached is inspectable rather than assumed.
 */
class FakeFormData {
  readonly entries: { field: string; value: unknown; filename?: string }[] = [];
  append(field: string, value: unknown, filename?: string): void {
    this.entries.push(filename === undefined ? { field, value } : { field, value, filename });
  }
}

let xhr_log: FakeXhrRecord[] = [];
let xhr_status = 200;
let xhr_response = JSON.stringify({ url: UPLOADED_URL });
let real_xhr: unknown;
let real_form_data: unknown;
/** The multipart body the upload client actually built, for inspection. */
let sent_body: FakeFormData | null = null;

class FakeXhr {
  status = 0;
  responseText = '';
  upload: { onprogress: ((ev: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private record: FakeXhrRecord = { method: '', url: '', headers: {} };

  open(method: string, url: string): void {
    this.record = { method, url, headers: {} };
  }
  setRequestHeader(key: string, value: string): void {
    this.record.headers[key.toLowerCase()] = value;
  }
  abort(): void {
    /* nothing in flight — the response is delivered synchronously below */
  }
  send(body: unknown): void {
    sent_body = body instanceof FakeFormData ? body : null;
    xhr_log.push(this.record);
    this.status = xhr_status;
    this.responseText = xhr_response;
    // Deliver on a microtask, not inline: a synchronous `onload` inside `send()`
    // would resolve the upload before the caller had even returned, which is not
    // how any real transport behaves and would hide an ordering bug.
    queueMicrotask(() => this.onload?.());
  }
}

beforeAll(() => {
  installNativeHarness();
  real_xhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  real_form_data = (globalThis as { FormData?: unknown }).FormData;
  (globalThis as { FormData?: unknown }).FormData = FakeFormData;
});

afterAll(() => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = real_xhr;
  (globalThis as { FormData?: unknown }).FormData = real_form_data;
  resetHarnessGlobals();
});

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
  resetHarnessAudio();
  xhr_log = [];
  sent_body = null;
  xhr_status = 200;
  xhr_response = JSON.stringify({ url: UPLOADED_URL });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

async function mountChat() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId: 'harness-project' }),
    ),
  );
  const socket = FakeChatSocket.current();
  await screen.settle();
  socket.onopen?.();
  await screen.settle();
  return { screen, socket };
}

/**
 * Let enough wall-clock pass that the clip counts as a real message.
 *
 * The recorder measures a take with `Date.now()` and discards anything under
 * `MIN_RECORDING_MS` as a misfire, so a test that stops instantly gets silently
 * dropped — correctly. Waiting for real time is unglamorous but it is the only
 * honest way to produce a long-enough recording without reaching inside the hook
 * and faking its clock, which would stop testing the guard at all.
 */
async function recordLongEnough(settle: () => Promise<void>): Promise<void> {
  await new Promise((r) => setTimeout(r, MIN_RECORDING_MS + 120));
  await settle();
}

describe('recording a voice message, tap mode', () => {
  it('a tap on the mic starts a real capture and shows the recording row', async () => {
    const { screen } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();

    const audio = harnessAudioState();
    expect(audio.permission_checks).toBe(1);
    expect(audio.record_calls).toBe(1);
    expect(audio.recording).toBe(true);
    // The overlay replaced the composer's resting state with a live one. The
    // latched wording is the tell that the tap was understood as tap-mode: the
    // finger is gone and the owner is owed a stop control.
    expect(screen.text()).toContain('Recording');

    screen.unmount();
  });

  it('stop → send puts the clip on the wire as an ordinary attachment', async () => {
    const { screen, socket } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();
    await recordLongEnough(screen.settle);

    await screen.press('Stop recording');
    await screen.settle();
    // Review, not sent: stopping must never send by itself.
    expect(socket.framesOfType('user_message')).toHaveLength(0);
    expect(harnessAudioState().recording).toBe(false);

    await screen.press('Send voice message');
    await screen.settle();

    // 1. It was uploaded, to the SAME endpoint an image uses — no second path.
    expect(xhr_log).toHaveLength(1);
    expect(xhr_log[0]?.url).toBe(`${BASE_URL}/api/app/upload`);
    expect(xhr_log[0]?.method).toBe('POST');
    expect(xhr_log[0]?.headers['authorization']).toBe(`Bearer ${OWNER.token}`);
    // The part carries a real audio extension. The gateway does not care, but
    // the transcription client routes on it (`voice-recording.ts` says so), and
    // it carries no timestamp or owner identity.
    const part = sent_body?.entries[0];
    expect(part?.field).toBe('file');
    expect(part?.filename).toBe('voice-note.m4a');
    expect((part?.value as { type?: string } | undefined)?.type).toBe('audio/mp4');

    // 2. It became a message — an empty body carrying the attachment, exactly
    //    the envelope an uploaded image produces.
    const frames = socket.framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('');
    expect(frames[0]?.['attachments']).toEqual([UPLOADED_URL]);
    expect(frames[0]?.['project_id']).toBe('harness-project');

    screen.unmount();
  });

  it('discarding at review uploads nothing and sends nothing', async () => {
    const { screen, socket } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();
    await recordLongEnough(screen.settle);
    await screen.press('Stop recording');
    await screen.settle();

    await screen.press('Discard voice message');
    await screen.settle();

    expect(xhr_log).toHaveLength(0);
    expect(socket.framesOfType('user_message')).toHaveLength(0);
    // Back to rest: the overlay is gone and the mic is the resting control again.
    expect(screen.byTestId('composer-voice')).not.toBeNull();

    screen.unmount();
  });
});

describe('recording a voice message, the paths that fail', () => {
  it('a refused microphone says so, and never leaves a capture running', async () => {
    setHarnessAudio({ granted: false, can_ask_again: false });
    const { screen, socket } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();

    // The owner is TOLD. A denied permission is a normal path, not a crash and
    // not a silent no-op.
    expect(screen.text()).toContain('Microphone access is off');
    expect(harnessAudioState().record_calls).toBe(0);
    expect(harnessAudioState().recording).toBe(false);
    expect(socket.framesOfType('user_message')).toHaveLength(0);

    screen.unmount();
  });

  it('an upload that fails is visible — the recording does not vanish quietly', async () => {
    xhr_status = 500;
    xhr_response = 'upstream exploded';
    const { screen, socket } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();
    await recordLongEnough(screen.settle);
    await screen.press('Stop recording');
    await screen.settle();
    await screen.press('Send voice message');
    await screen.settle();

    expect(xhr_log).toHaveLength(1);
    expect(screen.text()).toContain('Could not send the voice message');
    // Nothing half-sent: a failed upload must not produce a message with a URL
    // the gateway never issued.
    expect(socket.framesOfType('user_message')).toHaveLength(0);

    screen.unmount();
  });

  it('a misfire tap shorter than the minimum is dropped without an error banner', async () => {
    const { screen, socket } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();
    // No wait — stop immediately, which is what a mis-tap looks like.
    await screen.press('Stop recording');
    await screen.settle();

    expect(xhr_log).toHaveLength(0);
    expect(socket.framesOfType('user_message')).toHaveLength(0);
    // Silently back to rest. An error for something the owner obviously did not
    // mean to do is noise.
    expect(screen.text()).not.toContain('Could not send');
    expect(screen.byTestId('composer-voice')).not.toBeNull();

    screen.unmount();
  });
});

describe('the microphone is never left hot', () => {
  it('unmounting mid-recording stops the recorder', async () => {
    const { screen } = await mountChat();

    await screen.press('Record voice message');
    await screen.settle();
    expect(harnessAudioState().recording).toBe(true);

    screen.unmount();

    // Leaving the chat tab with the mic still capturing is the worst defect this
    // feature could have, so it is asserted rather than assumed.
    expect(harnessAudioState().recording).toBe(false);
  });
});
