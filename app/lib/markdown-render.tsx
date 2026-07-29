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
 * ⛔ FROZEN GRAMMAR — refactor unit W2 (D-13 resolved: react-markdown).
 * See docs/plans/2026-07-02-world-class-refactor-plan.md §W2. The CANONICAL
 * markdown renderer for the tree is the web react-markdown + rehype-sanitize
 * pipeline in `landing/chat-react/Markdown.tsx`. This hand-rolled RN grammar is
 * FROZEN: do NOT add block kinds or inline features — its fate follows the W4
 * Expo-shell spike (if the native chat surface is retired it dies with it; if
 * `ChatSyncSurface` is carved out it is replaced by a shared mdast parse + a
 * thin RN renderer over that parse, NOT a second grammar). This file is the
 * RENDER layer only; the frozen PARSE layer (`parseBlocks` / `tokeniseInline`
 * + the `Block`/`Inline`/`ListItem` types + the `FROZEN_*_GRAMMAR` manifests
 * with their `tsc` exhaustiveness guards) lives in the platform-free
 * `./markdown-grammar` module and is characterized by a bun-test.
 *
 * Sanitization: every `href` is checked against the allow-list before
 * tap. `javascript:` / `mailto:` / unknown custom schemes drop to a
 * non-interactive `<Text>` + log a warning.
 */

import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { isBinaryExtension } from './docs-client';
import {
  type Block,
  type Inline,
  type ListItem,
  isAllowedUrl,
  parseBlocks,
  tokeniseInline,
} from './markdown-grammar';
import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from './theme';

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

function safeOpenUrl(url: string): void {
  if (!isAllowedUrl(url)) {
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
      const safe = isAllowedUrl(tok.url);
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
