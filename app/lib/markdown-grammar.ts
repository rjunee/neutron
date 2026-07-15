/**
 * @neutronai/app — FROZEN native markdown grammar (parse layer only).
 *
 * ⛔ FROZEN GRAMMAR — refactor unit W2 (D-13 resolved: react-markdown).
 * See docs/plans/2026-07-02-world-class-refactor-plan.md §W2. The CANONICAL
 * markdown renderer for the tree is the web react-markdown + rehype-sanitize
 * pipeline in `landing/chat-react/Markdown.tsx`. This hand-rolled grammar is
 * FROZEN: do NOT add block kinds, inline constructs, or new syntax branches —
 * its fate follows the W4 Expo-shell spike (if the native chat surface is
 * retired it dies with it; if `ChatSyncSurface` is carved out it is replaced by
 * a shared mdast parse + a thin RN renderer over that parse, NOT a second
 * grammar).
 *
 * This module is the PLATFORM-FREE parse layer (no `react-native` import), split
 * out of `markdown-render.tsx` so the frozen grammar can be characterized by a
 * bun-test that exercises the REAL `parseBlocks` / `tokeniseInline` (the RN
 * runtime can't be loaded under bun). The `render` layer stays in
 * `markdown-render.tsx`. The `FROZEN_*_GRAMMAR` manifests + the exhaustiveness
 * guards below make `tsc` fail if a `Block`/`Inline` `kind` is added without a
 * deliberate edit to the frozen manifest — a speed-bump + review flag. (A new
 * syntax branch that emits an EXISTING kind is not caught by `tsc`; this banner
 * + review are the backstop, since the grammar is slated to die/be replaced in
 * W4 regardless.)
 *
 * Grammar (P5.1 locked subset): headers #..#### · fenced code (lang) · inline
 * code · bold · italic · strikethrough · bullet/numbered/task/1-level-nested
 * lists · blockquotes · horizontal rules · tables · links · images.
 */

// ── Block grammar ────────────────────────────────────────────────────────────

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] };

export interface ListItem {
  text: string;
  /** undefined = plain bullet; true = `- [x]` (checked/done); false = `- [ ]` (unchecked/todo). */
  checked?: boolean;
  /** Nested items one level deeper (P5.1 caps at one level). */
  children?: ListItem[];
}

// ── Inline grammar ───────────────────────────────────────────────────────────

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'strike'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'image'; alt: string; url: string };

// ── W2 FREEZE manifests + exhaustiveness guards ──────────────────────────────

/** Exhaustive set of block kinds this frozen grammar supports. */
export const FROZEN_MARKDOWN_GRAMMAR = [
  'paragraph',
  'code',
  'list',
  'heading',
  'blockquote',
  'hr',
  'table',
] as const;

/** Exhaustive set of inline token kinds this frozen grammar supports (`text` is
 *  the un-marked-up run between tokens). */
export const FROZEN_INLINE_GRAMMAR = [
  'text',
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'image',
] as const;

/** The block kinds of the frozen native markdown grammar. */
export type FrozenBlockKind = (typeof FROZEN_MARKDOWN_GRAMMAR)[number];
/** The inline token kinds of the frozen native markdown grammar. */
export type FrozenInlineKind = (typeof FROZEN_INLINE_GRAMMAR)[number];

/** `tsc` fails here if `A` and `B` are not the SAME set (mutual assignability),
 *  i.e. if the `Block`/`Inline` union and its frozen manifest diverge in either
 *  direction. A new grammar kind therefore forces a deliberate manifest edit. */
type AssertSameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _blockKindsFrozen: AssertSameSet<Block['kind'], FrozenBlockKind> = true;
const _inlineKindsFrozen: AssertSameSet<Inline['kind'], FrozenInlineKind> = true;
void _blockKindsFrozen;
void _inlineKindsFrozen;

// ── URL sanitization ─────────────────────────────────────────────────────────

/** Allow-list for tappable URLs in the frozen native renderer: `http(s)://`, the
 *  in-app `neutron://docs/` + `app://` schemes, and root-relative paths. The
 *  root-relative branch requires the leading `/` NOT be followed by another `/`
 *  or a `\` — otherwise a protocol-relative URL (`//host`, or `/\host` which a
 *  URL parser normalises to `//host`) would slip through as "root-relative" and
 *  resolve to an EXTERNAL origin. */
const URL_ALLOW = /^(https?:\/\/|neutron:\/\/docs\/|app:\/\/|\/(?![/\\]))/;

/** True iff `url` is safe to open / link. A URL that fails this is rendered
 *  non-interactively and never handed to `Linking.openURL` (see
 *  `markdown-render.tsx`) — `javascript:` / `mailto:` / `data:` / unknown custom
 *  schemes are dropped. Platform-free + exported so the sanitization contract is
 *  tested against PRODUCTION code rather than a copied regex. */
export function isAllowedUrl(url: string): boolean {
  return URL_ALLOW.test(url);
}

// ── Block parser ─────────────────────────────────────────────────────────────

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code
    if (line.trimStart().startsWith('```')) {
      const fence = line.trim();
      const lang = fence.slice(3).trim() || undefined;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      blocks.push({ kind: 'code', text: buf.join('\n'), ...(lang !== undefined ? { lang } : {}) });
      continue;
    }
    // ATX heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch !== null) {
      const hashes = headingMatch[1]!.length;
      const level = (hashes > 4 ? 4 : hashes) as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, text: headingMatch[2]!.trim() });
      i += 1;
      continue;
    }
    // Horizontal rule — three or more `-`, `*`, or `_` on their own line.
    if (
      /^\s*-{3,}\s*$/.test(line) ||
      /^\s*\*{3,}\s*$/.test(line) ||
      /^\s*_{3,}\s*$/.test(line)
    ) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }
    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', lines: buf });
      continue;
    }
    // Table — needs at least 2 lines (header + separator)
    if (
      /^\s*\|.+\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1] ?? '')
    ) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i] ?? '')) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    // List (bullet, numbered, task). Only a DEPTH-0 line opens a list — a child
    // (depth 1) is consumed inside `consumeListBlock`'s inner loop. Guarding on
    // depth 0 also guarantees progress: `consumeListBlock` always advances past
    // a depth-0 opener, whereas an ORPHAN indented marker (e.g. `  - child` with
    // no depth-0 parent) makes `consumeListBlock` break with `next_i` unchanged
    // — an infinite loop. Such orphans fall through to prose instead.
    const listMatch = matchListLine(line);
    if (listMatch !== null && listMatch.depth === 0) {
      const result = consumeListBlock(lines, i, listMatch.ordered);
      blocks.push({ kind: 'list', ordered: listMatch.ordered, items: result.items });
      i = result.next_i;
      continue;
    }
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    // Paragraph
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim().length > 0 &&
      !shouldBreakParagraph(lines[i] ?? '')
    ) {
      buf.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: buf.join('\n') });
  }
  return blocks;
}

function shouldBreakParagraph(line: string): boolean {
  if (line.trimStart().startsWith('```')) return true;
  if (matchListLine(line) !== null) return true;
  if (/^(#{1,6})\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*\|.+\|\s*$/.test(line)) return true;
  if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*{3,}\s*$/.test(line) || /^\s*_{3,}\s*$/.test(line)) return true;
  return false;
}

function matchListLine(line: string): { ordered: boolean; depth: number; rest: string; checked?: boolean } | null {
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (bullet !== null) {
    const indent = bullet[1]!.length;
    const rest = bullet[3] ?? '';
    const taskMatch = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
    if (taskMatch !== null) {
      return {
        ordered: false,
        depth: indent >= 2 ? 1 : 0,
        rest: taskMatch[2]!,
        checked: taskMatch[1]!.toLowerCase() === 'x',
      };
    }
    return { ordered: false, depth: indent >= 2 ? 1 : 0, rest };
  }
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (numbered !== null) {
    return { ordered: true, depth: numbered[1]!.length >= 2 ? 1 : 0, rest: numbered[3] ?? '' };
  }
  return null;
}

function consumeListBlock(
  lines: string[],
  start_i: number,
  ordered: boolean,
): { items: ListItem[]; next_i: number } {
  const items: ListItem[] = [];
  let i = start_i;
  while (i < lines.length) {
    const m = matchListLine(lines[i] ?? '');
    if (m === null || m.ordered !== ordered || m.depth !== 0) break;
    const item: ListItem = { text: m.rest };
    // `matchListLine` returns true for `[x]`, false for `[ ]`; undefined
    // for plain bullet / numbered. ListItem.checked mirrors that.
    if (m.checked !== undefined) item.checked = m.checked;
    i += 1;
    // Nested children
    while (i < lines.length) {
      const child = matchListLine(lines[i] ?? '');
      if (child === null) break;
      if (child.depth === 0) break;
      const childItem: ListItem = { text: child.rest };
      if (child.checked !== undefined) childItem.checked = child.checked;
      if (item.children === undefined) item.children = [];
      item.children.push(childItem);
      i += 1;
    }
    items.push(item);
  }
  return { items, next_i: i };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

// ── Inline tokenizer ─────────────────────────────────────────────────────────

export function tokeniseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  const len = source.length;
  while (cursor < len) {
    const next = nextMatch(source, cursor);
    if (next === null) {
      out.push({ kind: 'text', text: source.slice(cursor) });
      break;
    }
    if (next.index > cursor) {
      out.push({ kind: 'text', text: source.slice(cursor, next.index) });
    }
    out.push(next.token);
    cursor = next.end;
  }
  return out;
}

function nextMatch(source: string, from: number): { index: number; end: number; token: Inline } | null {
  const candidates: { index: number; end: number; token: Inline }[] = [];
  // Code `...`
  const codeRe = /`([^`]+)`/g;
  codeRe.lastIndex = from;
  const codeMatch = codeRe.exec(source);
  if (codeMatch !== null && codeMatch[1] !== undefined) {
    candidates.push({
      index: codeMatch.index,
      end: codeMatch.index + codeMatch[0].length,
      token: { kind: 'code', text: codeMatch[1] },
    });
  }
  // Image ![alt](url)
  const imageRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  imageRe.lastIndex = from;
  const imageMatch = imageRe.exec(source);
  if (imageMatch !== null && imageMatch[2] !== undefined) {
    candidates.push({
      index: imageMatch.index,
      end: imageMatch.index + imageMatch[0].length,
      token: { kind: 'image', alt: imageMatch[1] ?? '', url: imageMatch[2] },
    });
  }
  // Link [text](url)
  const linkRe = /(^|[^!])\[([^\]]+)\]\(([^)\s]+)\)/g;
  linkRe.lastIndex = from;
  const linkMatch = linkRe.exec(source);
  if (
    linkMatch !== null &&
    linkMatch[2] !== undefined &&
    linkMatch[3] !== undefined
  ) {
    const leading = linkMatch[1] ?? '';
    candidates.push({
      index: linkMatch.index + leading.length,
      end: linkMatch.index + linkMatch[0].length,
      token: { kind: 'link', text: linkMatch[2], url: linkMatch[3] },
    });
  }
  // Bold **...**
  const boldRe = /\*\*([^*]+)\*\*/g;
  boldRe.lastIndex = from;
  const boldMatch = boldRe.exec(source);
  if (boldMatch !== null && boldMatch[1] !== undefined) {
    candidates.push({
      index: boldMatch.index,
      end: boldMatch.index + boldMatch[0].length,
      token: { kind: 'bold', text: boldMatch[1] },
    });
  }
  // Strikethrough ~~text~~
  const strikeRe = /~~([^~]+)~~/g;
  strikeRe.lastIndex = from;
  const strikeMatch = strikeRe.exec(source);
  if (strikeMatch !== null && strikeMatch[1] !== undefined) {
    candidates.push({
      index: strikeMatch.index,
      end: strikeMatch.index + strikeMatch[0].length,
      token: { kind: 'strike', text: strikeMatch[1] },
    });
  }
  // Italic *...*  or _..._
  const italicAsteriskRe = /(^|[^*])\*([^*\n]+)\*/g;
  italicAsteriskRe.lastIndex = from;
  const italicMatch = italicAsteriskRe.exec(source);
  if (italicMatch !== null && italicMatch[2] !== undefined) {
    const leading = italicMatch[1] ?? '';
    candidates.push({
      index: italicMatch.index + leading.length,
      end: italicMatch.index + italicMatch[0].length,
      token: { kind: 'italic', text: italicMatch[2] },
    });
  }
  const italicUnderscoreRe = /(^|[^_a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g;
  italicUnderscoreRe.lastIndex = from;
  const underscoreMatch = italicUnderscoreRe.exec(source);
  if (underscoreMatch !== null && underscoreMatch[2] !== undefined) {
    const leading = underscoreMatch[1] ?? '';
    candidates.push({
      index: underscoreMatch.index + leading.length,
      end: underscoreMatch.index + underscoreMatch[0].length,
      token: { kind: 'italic', text: underscoreMatch[2] },
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0] ?? null;
}
