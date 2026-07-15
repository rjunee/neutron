/**
 * @neutronai/app — FROZEN native markdown grammar characterization tests (W2).
 *
 * These exercise the REAL, production `parseBlocks` + `tokeniseInline` from the
 * platform-free `markdown-grammar` module (the parse layer was split out of the
 * RN-only `markdown-render.tsx` so bun can load it directly). Because the
 * grammar is FROZEN pending W4 (D-13 resolved: react-markdown is canonical; the
 * web pipeline in `landing/chat-react/Markdown.tsx` is THE grammar), these are
 * characterization tests: they pin CURRENT behavior of every frozen block kind
 * and inline construct, including malformed / near-match inputs, so a
 * regression (or a change to how an EXISTING construct parses) trips a test.
 *
 * What the freeze mechanism DOES vs does NOT catch (be precise — no overclaim):
 *   - GUARANTEED (tsc): a new `Block`/`Inline` discriminant `kind` cannot be
 *     added without a deliberate edit to `FROZEN_*_GRAMMAR` — the exhaustiveness
 *     guards in markdown-grammar.ts fail to compile otherwise.
 *   - GUARANTEED (these tests): the parse output for every covered construct is
 *     pinned, so changing existing syntax behavior fails a characterization.
 *   - NOT caught mechanically: a brand-new syntax branch that emits an EXISTING
 *     kind (e.g. a `== `-style heading) — the input space is infinite, so no
 *     finite corpus can prove its absence. The prominent FREEZE banner in
 *     markdown-grammar.ts + markdown-render.tsx and code review are the backstop
 *     there; this is inherent to freezing (rather than deleting) a hand parser,
 *     and the grammar is slated for retirement/replacement in W4 regardless.
 *
 * Block kinds covered: paragraph, code(+lang), heading(1..4, >4 clamp),
 *   blockquote, hr (dash/asterisk/underscore), list(bullet/numbered/task/nested),
 *   table.
 * Inline kinds covered: text, bold, italic (asterisk + underscore), strike,
 *   code, link, image.
 * Plus: paragraph-break heuristics, malformed/near-match rejection, and the
 * `FROZEN_*_GRAMMAR` manifests staying in sync with what the parser emits.
 */

import { describe, expect, it } from 'bun:test';

import {
  type Block,
  type Inline,
  FROZEN_INLINE_GRAMMAR,
  FROZEN_MARKDOWN_GRAMMAR,
  isAllowedUrl,
  parseBlocks,
  tokeniseInline,
} from '../lib/markdown-grammar';

const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.kind);

describe('parseBlocks — block grammar', () => {
  it('parses ATX headings #..#### and clamps > 4 to level 4', () => {
    expect(parseBlocks('# H1')).toEqual([{ kind: 'heading', level: 1, text: 'H1' }]);
    expect(parseBlocks('#### H4')).toEqual([{ kind: 'heading', level: 4, text: 'H4' }]);
    // 5 and 6 hashes are still valid ATX but clamp to the level-4 render style.
    expect(parseBlocks('###### deep')).toEqual([{ kind: 'heading', level: 4, text: 'deep' }]);
  });

  it('requires a space after the hashes (else it is a paragraph)', () => {
    expect(kinds(parseBlocks('#notaheading'))).toEqual(['paragraph']);
  });

  it('parses a fenced code block with a language and preserves body verbatim', () => {
    expect(parseBlocks('```ts\nconst x = 1\n```')).toEqual([
      { kind: 'code', text: 'const x = 1', lang: 'ts' },
    ]);
  });

  it('parses a fenced code block with no language (lang omitted)', () => {
    expect(parseBlocks('```\nplain\n```')).toEqual([{ kind: 'code', text: 'plain' }]);
  });

  it('parses horizontal rules from ---, ***, and ___', () => {
    expect(parseBlocks('---')).toEqual([{ kind: 'hr' }]);
    expect(parseBlocks('***')).toEqual([{ kind: 'hr' }]);
    expect(parseBlocks('___')).toEqual([{ kind: 'hr' }]);
  });

  it('parses a blockquote, stripping the > marker per line', () => {
    expect(parseBlocks('> a\n> b')).toEqual([{ kind: 'blockquote', lines: ['a', 'b'] }]);
  });

  it('parses bullet, numbered, task, and one-level nested lists', () => {
    expect(parseBlocks('- one\n- two')).toEqual([
      { kind: 'list', ordered: false, items: [{ text: 'one' }, { text: 'two' }] },
    ]);
    expect(parseBlocks('1. first\n2. second')).toEqual([
      { kind: 'list', ordered: true, items: [{ text: 'first' }, { text: 'second' }] },
    ]);
    expect(parseBlocks('- [ ] todo\n- [x] done')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          { text: 'todo', checked: false },
          { text: 'done', checked: true },
        ],
      },
    ]);
    expect(parseBlocks('- parent\n  - child')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [{ text: 'parent', children: [{ text: 'child' }] }],
      },
    ]);
  });

  it('treats an ORPHAN indented list marker as prose and terminates', () => {
    // Regression (Codex r3 P1): `  - child` (depth-1, no depth-0 parent) used to
    // make `consumeListBlock` break without advancing, hanging `parseBlocks`.
    // It must now parse as a paragraph — and, above all, RETURN.
    expect(parseBlocks('  - child')).toEqual([{ kind: 'paragraph', text: '  - child' }]);
    // A real nested list (depth-0 parent + depth-1 child) is unaffected.
    expect(parseBlocks('- parent\n  - child')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [{ text: 'parent', children: [{ text: 'child' }] }],
      },
    ]);
  });

  it('parses a table with a header + separator + rows', () => {
    expect(parseBlocks('| a | b |\n| - | - |\n| 1 | 2 |')).toEqual([
      { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    ]);
  });

  it('does NOT treat a pipe line without a separator row as a table', () => {
    // Near-match: no `| --- |` separator → it stays a paragraph.
    expect(kinds(parseBlocks('| a | b |\njust text'))).toEqual(['paragraph']);
  });

  it('coalesces consecutive prose lines into one paragraph', () => {
    expect(parseBlocks('line one\nline two')).toEqual([
      { kind: 'paragraph', text: 'line one\nline two' },
    ]);
  });

  it('breaks a paragraph when a block construct starts on the next line', () => {
    expect(kinds(parseBlocks('prose\n# heading'))).toEqual(['paragraph', 'heading']);
    expect(kinds(parseBlocks('prose\n- item'))).toEqual(['paragraph', 'list']);
    expect(kinds(parseBlocks('prose\n```\ncode\n```'))).toEqual(['paragraph', 'code']);
  });

  it('emits ONLY frozen block kinds across a mixed document', () => {
    const doc = [
      '# Title',
      '',
      'A paragraph with **bold**.',
      '',
      '```ts',
      'code()',
      '```',
      '',
      '> quote',
      '',
      '- a',
      '  - b',
      '1. one',
      '',
      '| h1 | h2 |',
      '| -- | -- |',
      '| c1 | c2 |',
      '',
      '---',
    ].join('\n');
    const seen = new Set(kinds(parseBlocks(doc)));
    for (const k of seen) {
      expect(FROZEN_MARKDOWN_GRAMMAR as readonly string[]).toContain(k);
    }
    // The corpus exercises every frozen block kind at least once.
    expect([...seen].sort()).toEqual(
      ['blockquote', 'code', 'heading', 'hr', 'list', 'paragraph', 'table'].sort(),
    );
  });
});

const inlineKinds = (tokens: Inline[]): string[] => tokens.map((t) => t.kind);

describe('tokeniseInline — inline grammar', () => {
  it('returns a single text token for un-marked-up prose', () => {
    expect(tokeniseInline('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('tokenises bold, italic (* and _), strikethrough, and inline code', () => {
    expect(tokeniseInline('**b**')).toEqual([{ kind: 'bold', text: 'b' }]);
    expect(tokeniseInline('*i*')).toEqual([{ kind: 'italic', text: 'i' }]);
    expect(tokeniseInline('_i_')).toEqual([{ kind: 'italic', text: 'i' }]);
    expect(tokeniseInline('~~s~~')).toEqual([{ kind: 'strike', text: 's' }]);
    expect(tokeniseInline('`c`')).toEqual([{ kind: 'code', text: 'c' }]);
  });

  it('tokenises links and images with their url', () => {
    expect(tokeniseInline('[text](http://x)')).toEqual([
      { kind: 'link', text: 'text', url: 'http://x' },
    ]);
    expect(tokeniseInline('![alt](http://img)')).toEqual([
      { kind: 'image', alt: 'alt', url: 'http://img' },
    ]);
  });

  it('does NOT treat an underscore inside a word as italic', () => {
    // Near-match: snake_case must survive as plain text.
    expect(tokeniseInline('snake_case_word')).toEqual([
      { kind: 'text', text: 'snake_case_word' },
    ]);
  });

  it('leaves an unclosed bold marker as plain text', () => {
    expect(tokeniseInline('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }]);
  });

  it('splits surrounding prose into text tokens around a match', () => {
    expect(tokeniseInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('emits ONLY frozen inline kinds across a mixed run', () => {
    const run = 'plain **bold** _em_ ~~del~~ `code` [l](http://x) ![a](http://i)';
    const seen = new Set(inlineKinds(tokeniseInline(run)));
    for (const k of seen) {
      expect(FROZEN_INLINE_GRAMMAR as readonly string[]).toContain(k);
    }
    expect([...seen].sort()).toEqual(
      ['bold', 'code', 'image', 'italic', 'link', 'strike', 'text'].sort(),
    );
  });
});

describe('W2 grammar freeze manifests', () => {
  // The frozen manifests are the single source of truth the `tsc` exhaustiveness
  // guards (in markdown-grammar.ts) pin the `Block`/`Inline` unions against.
  // Pinning them here catches a manifest edit made to silence the type guard.
  it('pins the exhaustive block-kind set', () => {
    const blockKinds: string[] = [...FROZEN_MARKDOWN_GRAMMAR];
    expect(blockKinds.sort()).toEqual(
      ['blockquote', 'code', 'heading', 'hr', 'list', 'paragraph', 'table'].sort(),
    );
  });
  it('pins the exhaustive inline-kind set', () => {
    const inlineKindsList: string[] = [...FROZEN_INLINE_GRAMMAR];
    expect(inlineKindsList.sort()).toEqual(
      ['bold', 'code', 'image', 'italic', 'link', 'strike', 'text'].sort(),
    );
  });
});

describe('isAllowedUrl — PRODUCTION URL sanitization predicate', () => {
  // Exercises the REAL exported predicate (markdown-grammar.ts), which the RN
  // renderer uses for both `safeOpenUrl` and dropping unsafe links to a
  // non-interactive <Text>. (Previously this asserted a copied regex, so a
  // production change went undetected — Codex r4 P1.)
  it('accepts http / https / neutron-docs / app / root-relative', () => {
    expect(isAllowedUrl('http://foo')).toBe(true);
    expect(isAllowedUrl('https://foo')).toBe(true);
    expect(isAllowedUrl('neutron://docs/foo')).toBe(true);
    expect(isAllowedUrl('app://launch')).toBe(true);
    expect(isAllowedUrl('/api/x')).toBe(true);
  });
  it('rejects javascript / mailto / data / custom unknown schemes', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('mailto:foo@bar')).toBe(false);
    expect(isAllowedUrl('data:text/html,xss')).toBe(false);
    expect(isAllowedUrl('neutron://launch/foo')).toBe(false);
  });
  it('is anchored + case-sensitive at the scheme boundary (no bypass)', () => {
    // The allow-list is `^`-anchored, so a scheme buried after a prefix is not
    // allowed, and leading whitespace is not trimmed away into an accept.
    expect(isAllowedUrl(' javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('x-http://foo')).toBe(false);
    expect(isAllowedUrl('HTTP://FOO')).toBe(false); // scheme match is case-sensitive
    expect(isAllowedUrl('  /api/x')).toBe(false); // leading spaces are not root-relative
    expect(isAllowedUrl('')).toBe(false);
  });
  it('accepts a true root-relative path but REJECTS protocol-relative bypasses', () => {
    // Regression (Codex r5 P1): `//host` and `/\host` are external origins, not
    // root-relative — they must not reach Linking.openURL.
    expect(isAllowedUrl('/safe')).toBe(true);
    expect(isAllowedUrl('/')).toBe(true);
    expect(isAllowedUrl('//evil.example/path')).toBe(false);
    expect(isAllowedUrl('/\\evil.example/path')).toBe(false); // backslash normalises to //
    expect(isAllowedUrl('\\\\evil.example')).toBe(false); // leading backslashes
  });
});
