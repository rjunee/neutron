/**
 * @neutronai/app — the mobile local-Whisper install control.
 *
 * Voice notes are a phone feature, and until this landed the ONLY switch that
 * decided how they are transcribed lived in the web Settings tab. This file
 * covers the parts of the port that can be silently wrong:
 *
 *   1. the request the client actually puts on the wire;
 *   2. a server that predates the surface (404) reading as "update your server"
 *      rather than a bug;
 *   3. `installBlocker` — the guard against a control that LOOKS live and does
 *      nothing, which is the worst outcome available here;
 *   4. the honest model copy: measured cost visible, and the large model marked
 *      as slower than the recording rather than merely "better";
 *   5. that the card is actually MOUNTED on /settings (built-but-not-wired is
 *      the repo's oldest defect class), and
 *   6. that the app's re-declared wire types still match the web client's.
 *
 * The app suite mounts no React Native components (see the note atop
 * `diagnostics-pane-render.test.ts`), so 5 is a source-pin in the established
 * style of `server-editor-reachability.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  VoiceTranscriptionClient,
  VoiceTranscriptionClientError,
  VOICE_TRANSCRIPTION_PATH,
  type VoiceTranscriptionStatus,
  type WhisperModelOption,
} from '../lib/voice-transcription-client';
import {
  backendBlocker,
  choiceIsStalled,
  describeBackend,
  describeBackendOption,
  describeJob,
  describeKeySource,
  describeModel,
  describeStatusFailure,
  formatBytes,
  installBlocker,
  isJobRunning,
  isSlowerThanRealTime,
  jobFraction,
  modelTitle,
} from '../lib/voice-transcription-view';

const REPO_ROOT = join(__dirname, '..', '..');
const APP_ROOT = join(__dirname, '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(responder: (req: Captured) => { status: number; body: unknown; json?: boolean }): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw = init.headers;
    if (raw !== undefined && !(raw instanceof Headers) && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const captured: Captured = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: String(init.body ?? ''),
    };
    calls.push(captured);
    const result = responder(captured);
    if (result.json === false) {
      return new Response(String(result.body), { status: result.status });
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function status(overrides: Partial<VoiceTranscriptionStatus> = {}): VoiceTranscriptionStatus {
  return {
    backend: 'none',
    backend_reason: 'unconfigured',
    choice: null,
    local_available: false,
    openai_key: { present: false, source: null, saved_at: null },
    installed: false,
    model_id: null,
    installed_bytes: 0,
    binary_downloadable: true,
    binary_present: false,
    whisper_version: 'v1.9.1',
    default_model_id: 'base',
    models: [model()],
    job: null,
    ...overrides,
  };
}

function model(overrides: Partial<WhisperModelOption> = {}): WhisperModelOption {
  return {
    id: 'base',
    label: 'Base — fast (recommended)',
    size_bytes: 147_951_465,
    sec_per_30s_note: 3.8,
    peak_rss_mb: 343,
    note: 'A 30-second note is text in about 4 seconds.',
    ...overrides,
  };
}

describe('VoiceTranscriptionClient — the wire', () => {
  it('GET carries the owner bearer to the machine-scoped path', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: status() }));
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com/',
      token: 'tok',
      fetchImpl,
    });
    await client.status();
    expect(calls).toHaveLength(1);
    // Trailing slash on the base must not double up.
    expect(calls[0]!.url).toBe(`https://neutron.example.com${VOICE_TRANSCRIPTION_PATH}`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok');
  });

  it('install POSTs the chosen model id', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 202, body: status() }));
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com',
      token: 'tok',
      fetchImpl,
    });
    await client.install('small');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body)).toEqual({ model_id: 'small' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('remove issues a DELETE with no body', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: status() }));
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com',
      token: 'tok',
      fetchImpl,
    });
    await client.remove();
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.body).toBe('');
  });

  it('a non-2xx surfaces the server code + message, with the status', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 409,
      body: { ok: false, code: 'install_running', message: 'wait for it to finish first' },
    }));
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com',
      token: 'tok',
      fetchImpl,
    });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceTranscriptionClientError);
    expect((err as VoiceTranscriptionClientError).status).toBe(409);
    expect((err as VoiceTranscriptionClientError).code).toBe('install_running');
  });

  it('a non-JSON 404 keeps its STATUS so the screen can name the real cause', async () => {
    // An older server answers the unmatched path with an HTML/text 404. Losing
    // the status here would turn "your server is out of date" into a parse error.
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: 'Not Found', json: false }));
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com',
      token: 'tok',
      fetchImpl,
    });
    const err = await client.status().catch((e: unknown) => e);
    expect((err as VoiceTranscriptionClientError).status).toBe(404);
    expect(describeStatusFailure(err).kind).toBe('unsupported');
  });
});

describe('a server that never answers', () => {
  it('times out instead of leaving the card loading forever', async () => {
    // Observed live on device: with the local instance stopped mid-session the
    // request neither resolved nor rejected (the connection was accepted and
    // went nowhere) and the card sat on "Checking your server…" indefinitely.
    // `fetch` has no default timeout, so the client owns one.
    const hang = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    const client = new VoiceTranscriptionClient({
      base_url: 'https://neutron.example.com',
      token: 'tok',
      fetchImpl: hang,
      timeoutMs: 30,
    });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceTranscriptionClientError);
    expect((err as VoiceTranscriptionClientError).code).toBe('timeout');
    expect(describeStatusFailure(err).message).toContain('did not answer');
  });
});

describe('describeStatusFailure — the reason, not just the failure', () => {
  it('404 is an out-of-date server, not an error', () => {
    const failure = describeStatusFailure(new VoiceTranscriptionClientError(404, 'x', 'nope'));
    expect(failure.kind).toBe('unsupported');
    expect(failure.message).toContain('Update the server');
  });

  it('401 points at the session', () => {
    expect(describeStatusFailure(new VoiceTranscriptionClientError(401, 'unauthorized', 'bad')).kind).toBe(
      'unauthorized',
    );
  });

  it('anything else keeps the message rather than inventing one', () => {
    const failure = describeStatusFailure(new Error('Network request failed'));
    expect(failure.kind).toBe('error');
    expect(failure.message).toBe('Network request failed');
  });
});

describe('installBlocker — never ship a dead control', () => {
  it('blocks when the server can neither download nor already run whisper.cpp', () => {
    const blocked = installBlocker(status({ binary_downloadable: false, binary_present: false }));
    expect(blocked).not.toBeNull();
    // It has to say WHY and that the phone cannot fix it.
    expect(blocked).toContain('brew install whisper-cpp');
    expect(blocked).toContain('cannot be done from the phone');
  });

  it('does not block when a binary is already present (Homebrew / pinned)', () => {
    expect(installBlocker(status({ binary_downloadable: false, binary_present: true }))).toBeNull();
  });

  it('does not block on a platform with a prebuilt binary', () => {
    expect(installBlocker(status({ binary_downloadable: true, binary_present: false }))).toBeNull();
  });

  it('does not block once it is installed (that card shows Remove)', () => {
    expect(
      installBlocker(status({ installed: true, binary_downloadable: false, binary_present: false })),
    ).toBeNull();
  });
});

describe('status + progress copy', () => {
  it('names the backend actually in use', () => {
    expect(describeBackend(status({ backend: 'local', model_id: 'base', installed_bytes: 147_951_465 }))).toBe(
      'Transcribing on this server — base model (141 MB on disk)',
    );
    expect(describeBackend(status({ backend: 'openai' }))).toContain('OpenAI API');
  });

  it('when nothing runs, it says WHICH of the four situations this is', () => {
    // One generic "not transcribed" line was the original complaint: it left the
    // owner unable to tell an unconfigured box from a choice that cannot run.
    expect(describeBackend(status({ backend: 'none', backend_reason: 'unchosen' }))).toContain(
      'pick the one you want',
    );
    expect(
      describeBackend(status({ backend: 'none', backend_reason: 'local_not_installed' })),
    ).toContain('not installed yet');
    expect(
      describeBackend(status({ backend: 'none', backend_reason: 'openai_key_missing' })),
    ).toContain('no API key is saved');
    expect(describeBackend(status({ backend: 'none', backend_reason: 'unconfigured' }))).toContain(
      'set up one of the options',
    );
  });

  it('a choice that is not running is flagged — and nothing was substituted for it', () => {
    // The server never falls back, so this state means "your choice cannot run",
    // never "we quietly used the other one".
    expect(choiceIsStalled(status({ backend: 'none', choice: 'openai' }))).toBe(true);
    expect(choiceIsStalled(status({ backend: 'openai', choice: 'openai' }))).toBe(false);
    expect(choiceIsStalled(status({ backend: 'none', choice: null }))).toBe(false);
  });

  it('each option says why it cannot serve a note yet, before it is picked', () => {
    const bare = status();
    expect(backendBlocker(bare, 'local')).toContain('Not installed');
    expect(backendBlocker(bare, 'openai')).toContain('No API key');
    const ready = status({
      local_available: true,
      openai_key: { present: true, source: 'stored', saved_at: '2026-08-01T00:00:00.000Z' },
    });
    expect(backendBlocker(ready, 'local')).toBeNull();
    expect(backendBlocker(ready, 'openai')).toBeNull();
  });

  it('a key from the server environment says so — it cannot be removed from here', () => {
    const env = status({ openai_key: { present: true, source: 'environment', saved_at: null } });
    expect(describeKeySource(env)).toContain('OPENAI_API_KEY');
    expect(describeKeySource(status())).toBeNull();
  });

  it('neither option is sold as the better one, and slowness is blamed on the hardware', () => {
    // The measured timings in the catalog come from a server with no GPU. Copy
    // that called local "slower" full stop would be wrong on a Mac with Metal.
    const local = describeBackendOption('local');
    expect(local).toContain('no GPU');
    expect(local).toContain('never leaves the machine');
    const openai = describeBackendOption('openai');
    expect(openai).toContain('billed per minute');
    expect(openai).toContain('leaves your machine');
  });

  it('a job is running only in the phases where the server still has work', () => {
    expect(isJobRunning('downloading_model')).toBe(true);
    expect(isJobRunning('checking_disk')).toBe(true);
    expect(isJobRunning('verifying')).toBe(true);
    expect(isJobRunning('done')).toBe(false);
    expect(isJobRunning('failed')).toBe(false);
    expect(isJobRunning('idle')).toBe(false);
    expect(isJobRunning(null)).toBe(false);
  });

  it('progress is REAL bytes, not a spinner', () => {
    const job = {
      phase: 'downloading_model' as const,
      received_bytes: 73_975_732,
      total_bytes: 147_951_465,
      model_id: 'base',
      started_at: 0,
    };
    expect(jobFraction(job)).toBeCloseTo(0.5, 2);
    expect(describeJob(job)).toBe('Downloading the model — 71 MB of 141 MB');
  });

  it('an unknown total does not fake a full bar', () => {
    expect(
      jobFraction({
        phase: 'checking_disk',
        received_bytes: 0,
        total_bytes: 0,
        model_id: 'base',
        started_at: 0,
      }),
    ).toBeNull();
  });

  it('a failed job reports the server reason', () => {
    expect(
      describeJob({
        phase: 'failed',
        received_bytes: 10,
        total_bytes: 100,
        model_id: 'base',
        started_at: 0,
        error: { code: 'checksum_mismatch', message: 'expected sha256 … — nothing was installed' },
      }),
    ).toContain('nothing was installed');
  });

  it('formatBytes matches the web helper at each boundary', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(147_951_465)).toBe('141 MB');
    expect(formatBytes(1_624_555_275)).toBe('1.5 GB');
  });
});

describe('model copy — measured, not marketed', () => {
  it('states download size, wall-clock per note, and RAM before the tap', () => {
    expect(describeModel(model())).toBe('141 MB download · ~3.8s per 30-second note · 343 MB RAM');
  });

  it('does not say "recommended" twice when the catalog label already does', () => {
    // Caught on device: the card rendered "Base — fast (recommended) · recommended".
    expect(modelTitle(model({ label: 'Base — fast (recommended)' }), true)).toBe(
      'Base — fast (recommended)',
    );
    expect(modelTitle(model({ label: 'Base — fast' }), true)).toBe('Base — fast · recommended');
    expect(modelTitle(model({ label: 'Small — more accurate' }), false)).toBe(
      'Small — more accurate',
    );
  });

  it('marks a model that takes LONGER than the recording it transcribes', () => {
    // The measured reason `base` is the default: large-v3-turbo needs 50 s for a
    // 30-second note (whisper-catalog.ts). "Most accurate" must not read as "best".
    expect(isSlowerThanRealTime(model({ id: 'base', sec_per_30s_note: 3.8 }))).toBe(false);
    expect(isSlowerThanRealTime(model({ id: 'small', sec_per_30s_note: 12.4 }))).toBe(false);
    expect(isSlowerThanRealTime(model({ id: 'large-v3-turbo', sec_per_30s_note: 50 }))).toBe(true);
  });
});

describe('WIRED — the card is mounted on /settings and reads live status', () => {
  const settings = read(APP_ROOT, 'app', 'settings.tsx');

  it('settings.tsx renders the card', () => {
    // Element form, not a substring: `<VoiceTranscriptionCardSomethingElse` must
    // not satisfy this (mutation-tested).
    expect(settings).toMatch(/<VoiceTranscriptionCard[\s/>]/);
    expect(settings).toContain("from '../components/VoiceTranscriptionCard'");
  });

  it('it is fed by a real client call, not placeholder state', () => {
    expect(settings).toContain('new VoiceTranscriptionClient(');
    expect(settings).toContain('asrClient.status()');
    expect(settings).toContain('asrClient.install(');
    expect(settings).toContain('asrClient.remove()');
  });

  it('progress polls while a job runs and resumes when the app returns', () => {
    // A phone backgrounds during a 1.6 GB download; the JS timer does not run
    // there. Without the foreground refetch the owner comes back to a bar frozen
    // where they left it, which is indistinguishable from a stalled install.
    expect(settings).toContain('setInterval');
    // The CALL, not just the import — deleting the guard while leaving the
    // import behind must fail here (mutation-tested).
    expect(settings).toMatch(/if \(appStateBecameActive\(appState\.current, next\)\)\s*void loadAsr\(\)/);
  });

  it('the card exposes the controls it claims to (testIDs the device pass drives)', () => {
    const card = read(APP_ROOT, 'components', 'VoiceTranscriptionCard.tsx');
    expect(card).toContain('settings-voice-transcription-card');
    expect(card).toContain('settings-voice-transcription-install');
    expect(card).toContain('settings-voice-transcription-remove');
    expect(card).toContain('settings-voice-transcription-blocked');
    // The backend chooser + key field are the point of this screen now. A
    // control that exists only on the web tab is unreachable for an owner who
    // records voice notes on a phone, which is how the local-Whisper card came
    // to be ported in the first place.
    // Rendered from the `['local', 'openai']` pair, so pin the template AND the
    // pair — a row that stopped being generated would leave one of them unbuilt.
    expect(card).toContain('settings-voice-backend-${backend}');
    expect(card).toMatch(/\(\['local', 'openai'\] as const\)\.map/);
    expect(card).toContain('settings-voice-openai-key-input');
    expect(card).toContain('settings-voice-openai-key-save');
    expect(card).toContain('settings-voice-openai-key-remove');
  });

  it('the key input is masked and free of keyboard "help" that mangles a key', () => {
    const card = read(APP_ROOT, 'components', 'VoiceTranscriptionCard.tsx');
    expect(card).toContain('secureTextEntry');
    expect(card).toMatch(/autoCapitalize="none"/);
    expect(card).toMatch(/autoCorrect=\{false\}/);
  });

  it('the card never renders a stored key back — there is no field that could', () => {
    // The server sends presence + provenance + a date, never key material, so
    // nothing in the card may reach for a value-shaped field.
    const card = read(APP_ROOT, 'components', 'VoiceTranscriptionCard.tsx');
    expect(card).not.toMatch(/openai_key\.(key|value|plaintext|masked|hint|last4)/);
  });

  it('/settings wires the three new handlers to the card (built-but-not-wired guard)', () => {
    const settings = read(APP_ROOT, 'app', 'settings.tsx');
    expect(settings).toMatch(/onChooseBackend=\{handleChooseBackend\}/);
    expect(settings).toMatch(/onSaveOpenAiKey=\{handleSaveOpenAiKey\}/);
    expect(settings).toMatch(/onRemoveOpenAiKey=\{handleRemoveOpenAiKey\}/);
    // And that each actually calls the client, rather than being a named no-op.
    expect(settings).toContain('c.chooseBackend(backend)');
    expect(settings).toContain('c.saveOpenAiKey(api_key)');
    expect(settings).toContain('c.removeOpenAiKey()');
  });
});

describe('MIRROR PARITY — the app re-declares the web client wire types', () => {
  // Same discipline as `tab-descriptor-mirror-parity.test.ts`: the duplication
  // is deliberate (no browser package in the Metro bundle) so it needs a
  // mechanical guard, or the two drift the first time the server adds a field.
  const web = read(REPO_ROOT, 'landing', 'chat-react', 'voice-transcription-client.ts');
  const app = read(APP_ROOT, 'lib', 'voice-transcription-client.ts');

  function fields(src: string, name: string): string[] {
    const start = src.indexOf(`export interface ${name} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start + `export interface ${name} {`.length);
    const end = body.indexOf('\n}');
    return body
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .split('\n')
      .map((line) => line.trim().replace(/;$/, '').replace(/\s+/g, ' '))
      .filter((line) => line.length > 0)
      .sort();
  }

  for (const name of ['VoiceTranscriptionStatus', 'WhisperJob', 'WhisperModelOption']) {
    it(`${name} is identical on both surfaces`, () => {
      expect(fields(app, name)).toEqual(fields(web, name));
    });
  }

  it('the install phases are the same set', () => {
    const phases = (src: string): string[] =>
      [...src.matchAll(/^\s*\| '([a-z_]+)';?$/gm)].map((m) => m[1]!).sort();
    expect(phases(app)).toEqual(phases(web));
  });
});
