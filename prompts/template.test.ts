import { describe, expect, test } from 'bun:test'

import {
  KNOWN_PROMPTS,
  TELEGRAM_CHAT_ID_PLACEHOLDER,
  TemplateError,
  buildPromptVars,
  loadPrompt,
  substituteTemplate,
} from './template.ts'

const SYNTHETIC_OWNER_HOME = '/tmp/test-owner'
const SYNTHETIC_CHAT_ID = '-100999000111'

/** The full owner-config var set every shipped prompt resolves against. */
const SYNTHETIC_VARS = {
  OWNER_HOME: SYNTHETIC_OWNER_HOME,
  TELEGRAM_CHAT_ID: SYNTHETIC_CHAT_ID,
}

describe('substituteTemplate', () => {
  test('substitutes a single token when its key is provided', () => {
    const out = substituteTemplate('write to {{OWNER_HOME}}/notes.md', {
      OWNER_HOME: SYNTHETIC_OWNER_HOME,
    })
    expect(out).toBe('write to /tmp/test-owner/notes.md')
  })

  test('substitutes every occurrence of every provided token', () => {
    const content =
      'A={{ALPHA}} B={{BRAVO}} again A={{ALPHA}} home={{OWNER_HOME}}'
    const out = substituteTemplate(content, {
      ALPHA: '1',
      BRAVO: '2',
      OWNER_HOME: SYNTHETIC_OWNER_HOME,
    })
    expect(out).toBe('A=1 B=2 again A=1 home=/tmp/test-owner')
  })

  test('throws TemplateError listing every missing key (sorted, deduped) when keys are missing', () => {
    const content =
      'home={{OWNER_HOME}} foo={{FOO}} again={{FOO}} bar={{BAR}}'
    expect(() => substituteTemplate(content, { OWNER_HOME: SYNTHETIC_OWNER_HOME })).toThrow(
      TemplateError,
    )
    try {
      substituteTemplate(content, { OWNER_HOME: SYNTHETIC_OWNER_HOME })
      throw new Error('expected substituteTemplate to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
      const te = err as TemplateError
      expect(te.missingKeys).toEqual(['BAR', 'FOO'])
      expect(te.message).toContain('{{BAR}}')
      expect(te.message).toContain('{{FOO}}')
      expect(te.message).not.toContain('{{OWNER_HOME}}')
    }
  })

  test('extra unused vars are non-fatal (succeeds; output unchanged)', () => {
    const out = substituteTemplate('home={{OWNER_HOME}}', {
      OWNER_HOME: SYNTHETIC_OWNER_HOME,
      UNUSED_VAR: 'irrelevant',
      ANOTHER_UNUSED: 'also irrelevant',
    })
    expect(out).toBe('home=/tmp/test-owner')
  })

  test('content with no template tokens passes through unchanged', () => {
    const content = 'no templates here, just prose. vault.example.test/foo'
    expect(substituteTemplate(content, {})).toBe(content)
  })

  test('empty-string substitution is treated as resolved (not missing)', () => {
    const out = substituteTemplate('home={{OWNER_HOME}}/end', { OWNER_HOME: '' })
    expect(out).toBe('home=/end')
  })

  test('lowercase {{key}} is NOT recognised as a template token (left untouched)', () => {
    const content = 'literal {{lowercase}} stays put; {{UPPER}} resolves'
    const out = substituteTemplate(content, { UPPER: 'ok' })
    expect(out).toBe('literal {{lowercase}} stays put; UPPER resolves'.replace('UPPER', 'ok'))
  })
})

describe('loadPrompt', () => {
  test('loads atlas.md, substitutes OWNER_HOME, and leaves no unresolved owner-home tokens', () => {
    const out = loadPrompt('atlas.md', { OWNER_HOME: SYNTHETIC_OWNER_HOME })
    // The substitution actually fired in body content (not just the header
    // comment): every owner-home token now points at the synthetic owner
    // home. (The persona was adapted for the substrate one-shot path, so the
    // owner-home token is now exercised via the obsidian-spec reference rather
    // than the removed tg-post self-delivery line.)
    expect(out).toContain(`${SYNTHETIC_OWNER_HOME}/docs/reference/tools/obsidian.md`)
    // The clean header block is still present (loadPrompt does not strip it);
    // scan only the body below it.
    const headerEnd = out.indexOf('-->')
    expect(headerEnd).toBeGreaterThan(0)
    const body = out.slice(headerEnd + '-->'.length)
    // No unresolved home tokens leaked through.
    expect(body).not.toContain('{{OWNER_HOME}}')
  })

  test('throws TemplateError when required vars are missing', () => {
    expect(() => loadPrompt('atlas.md', {})).toThrow(TemplateError)
  })

  test('every prompt in KNOWN_PROMPTS resolves cleanly with the owner-config vars', () => {
    expect(KNOWN_PROMPTS.length).toBeGreaterThan(0)
    for (const name of KNOWN_PROMPTS) {
      const out = loadPrompt(name, SYNTHETIC_VARS)
      // No template syntax leaks.
      expect(out).not.toMatch(/\{\{[A-Z_][A-Z0-9_]*\}\}/)
      // The synthetic home must appear at least once: every prompt references
      // the {{OWNER_HOME}} token in its source, so the substitution should
      // have produced at least one occurrence.
      expect(out).toContain(SYNTHETIC_OWNER_HOME)
    }
  })

  test('the reminder/topic prompts substitute {{TELEGRAM_CHAT_ID}} (no baked-in chat id survives)', () => {
    for (const name of ['reminder-agent-base.md', 'reminder-patterns.md', 'topic-agent-base.md']) {
      const out = loadPrompt(name, SYNTHETIC_VARS)
      // The owner chat id was actually injected — not left as literal text.
      expect(out).toContain(SYNTHETIC_CHAT_ID)
      expect(out).not.toContain('{{TELEGRAM_CHAT_ID}}')
    }
  })

  test('throws ENOENT-shaped error when the prompt file does not exist', () => {
    expect(() => loadPrompt('does-not-exist.md', { OWNER_HOME: SYNTHETIC_OWNER_HOME })).toThrow(
      /ENOENT|no such file/i,
    )
  })

  test('rejects prompt names that escape the prompts/ directory (no path traversal)', () => {
    const synth = { OWNER_HOME: SYNTHETIC_OWNER_HOME }
    expect(() => loadPrompt('../package.json', synth)).toThrow(/invalid prompt name/i)
    expect(() => loadPrompt('subdir/atlas.md', synth)).toThrow(/invalid prompt name/i)
    expect(() => loadPrompt('subdir\\atlas.md', synth)).toThrow(/invalid prompt name/i)
    expect(() => loadPrompt('/etc/passwd', synth)).toThrow(/invalid prompt name/i)
    expect(() => loadPrompt('Atlas.md', synth)).toThrow(/invalid prompt name/i) // uppercase is locked out
    expect(() => loadPrompt('atlas.txt', synth)).toThrow(/invalid prompt name/i) // wrong extension
    expect(() => loadPrompt('', synth)).toThrow(/invalid prompt name/i)
    expect(() => loadPrompt('-leading-dash.md', synth)).toThrow(/invalid prompt name/i)
  })

  test('KNOWN_PROMPTS exactly matches the .md files shipped on disk (sorted)', async () => {
    const { readdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const onDisk: string[] = readdirSync(here)
      .filter((name) => name.endsWith('.md') && name !== 'AGENTS.md')
      .sort()
    const known: string[] = [...KNOWN_PROMPTS]
    expect(onDisk).toEqual(known)
  })
})

describe('buildPromptVars', () => {
  test('reads OWNER_HOME + TELEGRAM_CHAT_ID straight from owner config (env)', () => {
    const vars = buildPromptVars({
      OWNER_HOME: SYNTHETIC_OWNER_HOME,
      TELEGRAM_CHAT_ID: SYNTHETIC_CHAT_ID,
    })
    expect(vars.OWNER_HOME).toBe(SYNTHETIC_OWNER_HOME)
    expect(vars.TELEGRAM_CHAT_ID).toBe(SYNTHETIC_CHAT_ID)
  })

  test('falls back to the clear placeholder when TELEGRAM_CHAT_ID is unset', () => {
    const vars = buildPromptVars({ OWNER_HOME: SYNTHETIC_OWNER_HOME })
    expect(vars.TELEGRAM_CHAT_ID).toBe(TELEGRAM_CHAT_ID_PLACEHOLDER)
    // The placeholder is a non-empty, obvious sentinel — never a real chat id.
    expect(vars.TELEGRAM_CHAT_ID.length).toBeGreaterThan(0)
    expect(vars.TELEGRAM_CHAT_ID).not.toMatch(/^-?\d+$/)
  })

  test('the produced vars drive a clean prompt substitution end-to-end', () => {
    const vars = buildPromptVars({
      OWNER_HOME: SYNTHETIC_OWNER_HOME,
      TELEGRAM_CHAT_ID: SYNTHETIC_CHAT_ID,
    })
    const out = loadPrompt('topic-agent-base.md', vars)
    expect(out).toContain(SYNTHETIC_CHAT_ID)
    expect(out).not.toMatch(/\{\{[A-Z_][A-Z0-9_]*\}\}/)
  })
})
