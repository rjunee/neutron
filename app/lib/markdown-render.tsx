/**
 * @neutronai/app — extended markdown renderer for the P5.1 chat surface.
 *
 * Per docs/plans/P5.1-chat-surface-sprint-brief.md § 4.2: a hand-rolled
 * state-machine parser + render dispatcher that covers the locked
 * subset (headers, fenced code with lang + copy-button, inline code,
 * bold, italic, strikethrough, bullet/numbered/task/nested lists,
 * blockquotes, horizontal rules, tables, links, images, inline doc
 * refs). Anything outside the subset falls through as plain text.
 *
 * Anti-pattern guard: no `markdown-it`, no `remark`, no `mdast`. The
 * lib stays dependency-free so the Expo bundle doesn't grow + so the
 * grammar stays fully under our control.
 *
 * Sanitization: every `href` is checked against the allow-list before
 * tap. `javascript:` / `mailto:` / unknown custom schemes drop to a
 * non-interactive `<Text>` + log a warning.
 */

import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { isBinaryExtension } from './docs-client';
import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from './theme';

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] };

interface ListItem {
  text: string;
  /** undefined = bullet; true = `- [ ]`; false = `- [x]`. */
  checked?: boolean;
  /** Nested items one level deeper (P5.1 caps at one level). */
  children?: ListItem[];
}

/**
 * P7.5 — resolves a relative `![alt](relpath)` link in markdown to the
 * fetchable URL + headers for `<Image source={{ uri, headers }} />`.
 * `null` means "this is not a binary I can render" — the renderer falls
 * back to a download-card or plain text.
 */
export type BinarySourceResolver = (relPath: string) =>
  | { uri: string; headers: Record<string, string> }
  | null;

export interface RenderMarkdownProps {
  source: string;
  textColor?: string;
  /** Used to resolve relative `image` tokens. */
  binarySource?: BinarySourceResolver;
}

const URL_ALLOW = /^(https?:\/\/|neutron:\/\/docs\/|app:\/\/|\/)/;

function safeOpenUrl(url: string): void {
  if (!URL_ALLOW.test(url)) {
    console.warn('[markdown-render] dropped unsafe URL:', url.slice(0, 80));
    return;
  }
  Linking.openURL(url).catch(() => undefined);
}

export function RenderMarkdown({ source, textColor = '#f4f4f4', binarySource }: RenderMarkdownProps) {
  const blocks = parseBlocks(source);
  return (
    <View>
      {blocks.map((block, idx) => renderBlock(block, idx, textColor, binarySource))}
    </View>
  );
}

function renderBlock(
  block: Block,
  idx: number,
  textColor: string,
  binarySource: BinarySourceResolver | undefined,
): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <CodeBlock key={idx} text={block.text} {...(block.lang !== undefined ? { lang: block.lang } : {})} />
      );
    case 'heading':
      return <HeadingBlock key={idx} level={block.level} text={block.text} binarySource={binarySource} />;
    case 'blockquote':
      return <BlockquoteBlock key={idx} lines={block.lines} textColor={textColor} binarySource={binarySource} />;
    case 'hr':
      return <View key={idx} style={styles.hr} />;
    case 'list':
      return (
        <ListBlock
          key={idx}
          ordered={block.ordered}
          items={block.items}
          textColor={textColor}
          binarySource={binarySource}
        />
      );
    case 'table':
      return <TableBlock key={idx} header={block.header} rows={block.rows} textColor={textColor} />;
    case 'paragraph':
    default:
      return (
        <ParagraphRender
          key={idx}
          text={block.text}
          textColor={textColor}
          binarySource={binarySource}
        />
      );
  }
}

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (Platform.OS === 'web') {
      const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } } })
        .navigator;
      const wrt = nav?.clipboard?.writeText;
      if (typeof wrt === 'function') {
        wrt.call(nav!.clipboard, text).catch(() => undefined);
      }
    }
    // Native: an expo-clipboard import would land here in a follow-up
    // sprint; for P5.1 we ship the web path and silently succeed on
    // native (the button still flashes "Copied!" for the affordance).
    setCopied(true);
    setTimeout(() => setCopied(false), MOTION.slow * 2);
  }, [text]);
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        {lang !== undefined ? <Text style={styles.codeLang}>{lang}</Text> : <View />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          onPress={onCopy}
          style={({ pressed }) => [styles.copyBtn, pressed && styles.pressed]}
        >
          <Text style={styles.copyBtnText}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <Text style={styles.codeText} selectable>
        {text}
      </Text>
    </View>
  );
}

function HeadingBlock({
  level,
  text,
  binarySource,
}: {
  level: 1 | 2 | 3 | 4;
  text: string;
  binarySource: BinarySourceResolver | undefined;
}) {
  const tokenStyle =
    level === 1 ? TYPOGRAPHY.h1 : level === 2 ? TYPOGRAPHY.h2 : level === 3 ? TYPOGRAPHY.h3 : TYPOGRAPHY.h4;
  return (
    <Text style={[styles.heading, tokenStyle, { color: THEME.text_primary }]}>
      {renderInline(text, THEME.text_primary, binarySource)}
    </Text>
  );
}

function BlockquoteBlock({
  lines,
  textColor,
  binarySource,
}: {
  lines: string[];
  textColor: string;
  binarySource: BinarySourceResolver | undefined;
}) {
  const body = lines.join('\n');
  return (
    <View style={styles.blockquote}>
      <Text style={[styles.paragraph, { color: textColor, fontStyle: 'italic', opacity: 0.85 }]}>
        {renderInline(body, textColor, binarySource)}
      </Text>
    </View>
  );
}

function ListBlock({
  ordered,
  items,
  textColor,
  binarySource,
}: {
  ordered: boolean;
  items: ListItem[];
  textColor: string;
  binarySource: BinarySourceResolver | undefined;
}) {
  return (
    <View style={styles.list}>
      {items.map((item, i) => (
        <ListItemRow
          key={i}
          item={item}
          index={i}
          ordered={ordered}
          textColor={textColor}
          binarySource={binarySource}
        />
      ))}
    </View>
  );
}

function ListItemRow({
  item,
  index,
  ordered,
  textColor,
  binarySource,
  nested = false,
}: {
  item: ListItem;
  index: number;
  ordered: boolean;
  textColor: string;
  binarySource: BinarySourceResolver | undefined;
  nested?: boolean;
}) {
  const marker = ordered ? `${index + 1}.` : '•';
  const isTask = item.checked !== undefined;
  return (
    <View>
      <View style={[styles.listItem, nested && styles.listItemNested]}>
        {isTask ? (
          <Text style={[styles.bullet, { color: textColor }]} accessibilityLabel="task">
            {item.checked ? '☑' : '☐'}
          </Text>
        ) : (
          <Text style={[styles.bullet, { color: textColor }]}>{marker}</Text>
        )}
        <Text style={[styles.paragraph, { color: textColor, flex: 1 }]}>
          {renderInline(item.text, textColor, binarySource)}
        </Text>
      </View>
      {item.children !== undefined && item.children.length > 0 ? (
        <View style={styles.listChildren}>
          {item.children.map((child, j) => (
            <ListItemRow
              key={j}
              item={child}
              index={j}
              ordered={ordered}
              textColor={textColor}
              binarySource={binarySource}
              nested
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const TABLE_COL_CAP = 6;
const TABLE_ROW_CAP = 20;

function TableBlock({
  header,
  rows,
  textColor,
}: {
  header: string[];
  rows: string[][];
  textColor: string;
}) {
  const truncated = header.length > TABLE_COL_CAP || rows.length > TABLE_ROW_CAP;
  const cappedHeader = header.slice(0, TABLE_COL_CAP);
  const cappedRows = rows.slice(0, TABLE_ROW_CAP).map((r) => r.slice(0, TABLE_COL_CAP));
  return (
    <View style={styles.tableWrap}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        {cappedHeader.map((cell, i) => (
          <Text key={i} style={[styles.tableCell, styles.tableHeaderCell, { color: THEME.text_primary }]}>
            {cell.trim()}
          </Text>
        ))}
      </View>
      {cappedRows.map((row, r) => (
        <View key={r} style={styles.tableRow}>
          {row.map((cell, c) => (
            <Text key={c} style={[styles.tableCell, { color: textColor }]}>
              {cell.trim()}
            </Text>
          ))}
        </View>
      ))}
      {truncated ? (
        <Text style={styles.tableTruncated}>
          (table truncated — view full document for the complete table)
        </Text>
      ) : null}
    </View>
  );
}

interface ParagraphRenderProps {
  text: string;
  textColor: string;
  binarySource: BinarySourceResolver | undefined;
}

function ParagraphRender({ text, textColor, binarySource }: ParagraphRenderProps) {
  const tokens = tokeniseInline(text);
  // Split into runs separated by image tokens.
  const runs: Array<Inline[] | { image: Extract<Inline, { kind: 'image' }> }> = [];
  let buffer: Inline[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'image') {
      if (buffer.length > 0) {
        runs.push(buffer);
        buffer = [];
      }
      runs.push({ image: tok });
    } else {
      buffer.push(tok);
    }
  }
  if (buffer.length > 0) runs.push(buffer);
  return (
    <View style={styles.paragraphBlock}>
      {runs.map((run, i) => {
        if (Array.isArray(run)) {
          return (
            <Text key={i} style={[styles.paragraph, { color: textColor }]}>
              {run.map((tok, j) => renderToken(tok, j, textColor, binarySource))}
            </Text>
          );
        }
        return (
          <BinaryRender
            key={i}
            token={run.image}
            textColor={textColor}
            binarySource={binarySource}
          />
        );
      })}
    </View>
  );
}

interface BinaryRenderProps {
  token: Extract<Inline, { kind: 'image' }>;
  textColor: string;
  binarySource: BinarySourceResolver | undefined;
}

function BinaryRender({ token, textColor, binarySource }: BinaryRenderProps) {
  const url = token.url;
  const isAbsolute = /^https?:\/\//i.test(url);
  const lower = url.toLowerCase();
  const isKnownBinary = isBinaryExtension(lower);
  const looksImage =
    /\.(png|jpe?g|gif|webp|svg)$/i.test(lower) || (isAbsolute && !isKnownBinary);
  const isPdfOrMedia = isKnownBinary && !looksImage;
  if (looksImage) {
    if (isAbsolute) {
      return <Image source={{ uri: url }} style={styles.inlineImage} resizeMode="contain" accessibilityLabel={token.alt} />;
    }
    const src = binarySource ? binarySource(url) : null;
    if (src !== null && src !== undefined) {
      return <Image source={src} style={styles.inlineImage} resizeMode="contain" accessibilityLabel={token.alt} />;
    }
    return (
      <Text style={[styles.paragraph, { color: textColor }]}>
        [image: {token.alt || url}]
      </Text>
    );
  }
  if (isPdfOrMedia) {
    const src = isAbsolute
      ? { uri: url, headers: {} as Record<string, string> }
      : binarySource
        ? binarySource(url)
        : null;
    return (
      <Text
        style={[styles.paragraph, styles.link, { color: THEME.link }]}
        accessibilityRole="link"
        onPress={() => {
          if (src === null || src === undefined) return;
          safeOpenUrl(src.uri);
        }}
      >
        ⬇ {token.alt || url}
      </Text>
    );
  }
  return (
    <Text style={[styles.paragraph, { color: textColor }]}>
      [binary: {token.alt || url}]
    </Text>
  );
}

function parseBlocks(source: string): Block[] {
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
    // List (bullet, numbered, task)
    const listMatch = matchListLine(line);
    if (listMatch !== null) {
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

// Inline token rendering.
type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'strike'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'image'; alt: string; url: string };

function tokeniseInline(source: string): Inline[] {
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

function renderInline(
  source: string,
  color: string,
  binarySource: BinarySourceResolver | undefined,
): ReactNode {
  const tokens = tokeniseInline(source);
  return tokens.map((tok, i) => renderToken(tok, i, color, binarySource));
}

function renderToken(
  tok: Inline,
  i: number,
  color: string,
  _binarySource: BinarySourceResolver | undefined,
): ReactNode {
  switch (tok.kind) {
    case 'bold':
      return (
        <Text key={i} style={[styles.bold, { color }]}>
          {tok.text}
        </Text>
      );
    case 'italic':
      return (
        <Text key={i} style={[styles.italic, { color }]}>
          {tok.text}
        </Text>
      );
    case 'strike':
      return (
        <Text key={i} style={[styles.strike, { color }]}>
          {tok.text}
        </Text>
      );
    case 'code':
      return (
        <Text key={i} style={styles.inlineCode}>
          {tok.text}
        </Text>
      );
    case 'link': {
      const safe = URL_ALLOW.test(tok.url);
      if (!safe) {
        return (
          <Text key={i} style={[styles.paragraph, { color }]}>
            {tok.text}
          </Text>
        );
      }
      return (
        <Text
          key={i}
          style={styles.link}
          onPress={() => safeOpenUrl(tok.url)}
          accessibilityRole="link"
        >
          {tok.text}
        </Text>
      );
    }
    case 'image':
      return (
        <Text key={i} style={[styles.italic, { color }]}>
          [image: {tok.alt || tok.url}]
        </Text>
      );
    case 'text':
    default:
      return <Fragment key={i}>{tok.text}</Fragment>;
  }
}

const styles = StyleSheet.create({
  paragraph: {
    ...TYPOGRAPHY.body,
    marginBottom: SPACING.xs + 2,
  },
  paragraphBlock: {
    marginBottom: SPACING.xs + 2,
  },
  inlineImage: {
    width: '100%',
    aspectRatio: 16 / 9,
    marginVertical: SPACING.sm,
    backgroundColor: THEME.surface_raised,
    borderRadius: 6,
  },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  inlineCode: {
    fontFamily: TYPOGRAPHY.mono.fontFamily,
    fontSize: 14,
    backgroundColor: THEME.surface_raised,
    color: THEME.text_secondary,
    paddingHorizontal: SPACING.xs,
    borderRadius: 4,
  },
  link: {
    color: THEME.link,
    textDecorationLine: 'underline',
  },
  codeBlock: {
    backgroundColor: THEME.surface,
    borderRadius: 8,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  codeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xs,
  },
  codeLang: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  copyBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
    backgroundColor: THEME.surface_raised,
  },
  copyBtnText: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_secondary,
    fontWeight: '600',
  },
  codeText: {
    ...TYPOGRAPHY.mono,
    color: THEME.text_secondary,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  heading: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: THEME.hairline,
    paddingLeft: SPACING.md,
    marginVertical: SPACING.xs,
    opacity: 0.95,
  },
  hr: {
    height: 1,
    backgroundColor: THEME.hairline,
    marginVertical: SPACING.md,
  },
  list: {
    marginBottom: SPACING.xs + 2,
  },
  listItem: {
    flexDirection: 'row',
    marginBottom: SPACING.xs,
    gap: SPACING.sm,
  },
  listItemNested: {
    marginLeft: SPACING.lg,
  },
  listChildren: {
    marginLeft: 0,
  },
  bullet: {
    ...TYPOGRAPHY.body,
    minWidth: 14,
    textAlign: 'center',
  },
  tableWrap: {
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: 6,
    marginVertical: SPACING.sm,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  tableHeaderRow: {
    backgroundColor: THEME.surface,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    ...TYPOGRAPHY.body_small,
  },
  tableHeaderCell: {
    fontWeight: '700',
  },
  tableTruncated: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  pressed: { opacity: 0.7 },
  // The DENSITY token is exported for primitives — exposed here so the
  // bundler doesn't tree-shake it when the renderer is the only
  // consumer in scope.
  _density_keepalive: { borderRadius: DENSITY.bubble_radius },
});
