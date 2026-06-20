/**
 * Unit tests for `onboarding/interview/fixture-anthropic-client.ts`.
 *
 * Covers:
 *   - In-memory fixture list resolves on first match
 *   - Multiple fixtures resolve deterministically (lex order)
 *   - model_in / system_contains / user_contains predicates
 *   - Miss raises a FixtureMissError with the probe payload
 *   - Disk load: reads .json files from a tmp dir, ignores other files
 *   - Disk load: bad JSON throws FixtureLoadError with the path
 *   - Disk load: missing call_id throws
 *   - maybeBuildFixtureClientFromEnv returns null when env unset
 *   - maybeBuildFixtureClientFromEnv returns a client when env set
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FixtureAnthropicClient,
  FixtureLoadError,
  FixtureMissError,
  maybeBuildFixtureClientFromEnv,
  type Fixture,
} from '../fixture-anthropic-client.ts'

const fix = (overrides: Partial<Fixture> & { call_id: string; text: string }): Fixture => ({
  call_id: overrides.call_id,
  match: overrides.match ?? {},
  response: { content: [{ type: 'text', text: overrides.text }] },
})

describe('FixtureAnthropicClient — in-memory fixtures', () => {
  test('resolves a fixture by call_id when no match predicates set', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [fix({ call_id: 'only-one', text: 'hello' })],
    })
    const resp = await client.messages.create({
      model: 'claude-haiku',
      messages: [{ role: 'user', content: 'anything' }],
      max_tokens: 100,
    })
    expect(resp.content).toEqual([{ text: 'hello' }])
  })

  test('matches model_in predicate (positive)', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({
          call_id: 'haiku-only',
          match: { model_in: ['claude-haiku'] },
          text: 'matched',
        }),
      ],
    })
    const resp = await client.messages.create({
      model: 'claude-haiku',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
    })
    expect(resp.content).toEqual([{ text: 'matched' }])
  })

  test('skips a fixture whose model_in excludes the inbound model', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({
          call_id: 'haiku-only',
          match: { model_in: ['claude-haiku'] },
          text: 'haiku',
        }),
        fix({ call_id: 'sonnet', match: { model_in: ['claude-sonnet'] }, text: 'sonnet' }),
      ],
    })
    const resp = await client.messages.create({
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
    })
    expect(resp.content).toEqual([{ text: 'sonnet' }])
  })

  test('system_contains predicate requires every needle', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({
          call_id: 'router',
          match: { system_contains: ['onboarding router', 'phase shape'] },
          text: 'r1',
        }),
      ],
    })
    // Missing one needle → miss.
    expect(
      async () =>
        await client.messages.create({
          model: 'm',
          system: 'onboarding router only',
          messages: [{ role: 'user', content: 'x' }],
          max_tokens: 100,
        }),
    ).toThrow(FixtureMissError)
    // All needles present → hit.
    const ok = await client.messages.create({
      model: 'm',
      system: 'You are the onboarding router. phase shape: pick-only',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
    })
    expect(ok.content).toEqual([{ text: 'r1' }])
  })

  test('user_contains predicate scans concatenated user messages', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({
          call_id: 'router-signup',
          match: { user_contains: ['signup', 'Casey'] },
          text: 'matched-signup',
        }),
      ],
    })
    const ok = await client.messages.create({
      model: 'm',
      messages: [
        { role: 'user', content: 'phase=signup' },
        { role: 'user', content: 'inbound_user_text="""Casey"""' },
      ],
      max_tokens: 100,
    })
    expect(ok.content).toEqual([{ text: 'matched-signup' }])
  })

  test('first-match-wins by lex ordering', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({ call_id: 'b-second', text: 'second' }),
        fix({ call_id: 'a-first', text: 'first' }),
      ],
    })
    // In-memory fixtures: the constructor preserves the supplied order
    // (lex ordering is for disk loads only). So caller controls order
    // when supplying fixtures directly.
    const r1 = await client.messages.create({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
    })
    expect(r1.content).toEqual([{ text: 'second' }])
  })

  test('miss throws FixtureMissError with probe', async () => {
    const client = new FixtureAnthropicClient({
      fixturesDir: '/tmp/unused',
      fixtures: [
        fix({
          call_id: 'only',
          match: { user_contains: ['nope'] },
          text: 't',
        }),
      ],
    })
    let caught: FixtureMissError | null = null
    try {
      await client.messages.create({
        model: 'm',
        system: 'sys',
        messages: [{ role: 'user', content: 'doesnt match' }],
        max_tokens: 100,
      })
    } catch (err) {
      caught = err as FixtureMissError
    }
    expect(caught).not.toBeNull()
    expect(caught!.probe.model).toBe('m')
    expect(caught!.probe.candidates).toEqual(['only'])
  })
})

describe('FixtureAnthropicClient — disk loading', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fixture-client-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('loads .json files in lex order; ignores other files', async () => {
    writeFileSync(
      join(dir, '01-haiku.json'),
      JSON.stringify({
        call_id: 'haiku',
        match: { model_in: ['m'] },
        response: { content: [{ type: 'text', text: 'haiku-resp' }] },
      }),
    )
    writeFileSync(
      join(dir, '00-fallback.json'),
      JSON.stringify({
        call_id: 'fallback',
        response: { content: [{ type: 'text', text: 'fallback-resp' }] },
      }),
    )
    writeFileSync(join(dir, 'README.md'), '# not a fixture')
    const client = new FixtureAnthropicClient({ fixturesDir: dir })
    expect(client.listCallIds()).toEqual(['fallback', 'haiku'])
    // fallback fires first (no predicate matches everything) — confirms lex order
    const r = await client.messages.create({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
    })
    expect(r.content).toEqual([{ text: 'fallback-resp' }])
  })

  test('bad JSON raises FixtureLoadError with the path', () => {
    writeFileSync(join(dir, 'broken.json'), '{not json')
    expect(() => new FixtureAnthropicClient({ fixturesDir: dir })).toThrow(
      FixtureLoadError,
    )
  })

  test('missing call_id raises FixtureLoadError', () => {
    writeFileSync(
      join(dir, 'no-call-id.json'),
      JSON.stringify({
        response: { content: [{ type: 'text', text: 'x' }] },
      }),
    )
    expect(() => new FixtureAnthropicClient({ fixturesDir: dir })).toThrow(
      FixtureLoadError,
    )
  })

  test('non-existent dir raises FixtureLoadError', () => {
    expect(
      () => new FixtureAnthropicClient({ fixturesDir: join(dir, 'nope') }),
    ).toThrow(FixtureLoadError)
  })

  test('empty response.content raises FixtureLoadError', () => {
    writeFileSync(
      join(dir, 'empty.json'),
      JSON.stringify({ call_id: 'empty', response: { content: [] } }),
    )
    expect(() => new FixtureAnthropicClient({ fixturesDir: dir })).toThrow(
      FixtureLoadError,
    )
  })
})

describe('maybeBuildFixtureClientFromEnv', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fixture-env-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns null when env var unset', () => {
    expect(maybeBuildFixtureClientFromEnv({})).toBeNull()
    expect(maybeBuildFixtureClientFromEnv({ NEUTRON_E2E_LLM_FIXTURES_DIR: '' })).toBeNull()
  })

  test('returns a client when env var set to a valid dir', () => {
    writeFileSync(
      join(dir, 'fixture.json'),
      JSON.stringify({
        call_id: 'c1',
        response: { content: [{ type: 'text', text: 'hi' }] },
      }),
    )
    const client = maybeBuildFixtureClientFromEnv({
      NEUTRON_E2E_LLM_FIXTURES_DIR: dir,
    })
    expect(client).not.toBeNull()
    expect(client!.listCallIds()).toEqual(['c1'])
  })
})
