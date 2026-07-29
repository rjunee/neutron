/**
 * @neutronai/app — inline citation chip row (P5.1).
 *
 * Renders an agent message's `citations[]` as a horizontal scrollable
 * row of pill-shaped chips: `[ {favicon} {title} ]`. Tap opens the
 * URL via `Linking.openURL`. The title truncates at 32 chars so a
 * long page title doesn't push the whole row wider than the bubble.
 *
 * Favicon: `https://www.google.com/s2/favicons?domain=<host>&sz=16`
 * — public endpoint, no auth, fast cache. If the favicon fails to
 * load (e.g. on a `neutron://` URL), fall back to a 🔗 glyph.
 *
 * Reused by P7.2 inline-comment threads (the same chip primitive shows
 * up next to comment-anchored citations).
 */

import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from './theme';

const URL_ALLOW = /^(https?:\/\/|neutron:\/\/docs\/|app:\/\/|\/)/;

export interface Citation {
  title: string;
  url: string;
}

export interface CitationChipRowProps {
  citations: ReadonlyArray<Citation>;
  /** Override `Linking.openURL` for tests. */
  onOpen?: (url: string) => void;
}

const TITLE_CAP = 32;

function faviconUrl(target: string): string | null {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.host)}&sz=16`;
  } catch {
    return null;
  }
}

function safeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= TITLE_CAP) return trimmed;
  return `${trimmed.slice(0, TITLE_CAP - 1).trim()}…`;
}

export function CitationChipRow({ citations, onOpen }: CitationChipRowProps) {
  if (citations.length === 0) return null;
  const dispatch = onOpen ?? ((url: string) => {
    if (!URL_ALLOW.test(url)) return;
    Linking.openURL(url).catch(() => undefined);
  });
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityLabel="citations"
    >
      {citations.map((c, i) => (
        <CitationChip key={`${c.url}-${i}`} citation={c} onOpen={dispatch} />
      ))}
    </ScrollView>
  );
}

function CitationChip({
  citation,
  onOpen,
}: {
  citation: Citation;
  onOpen: (url: string) => void;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const iconSrc = iconFailed ? null : faviconUrl(citation.url);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open citation: ${citation.title}`}
      onPress={() => onOpen(citation.url)}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      {iconSrc !== null ? (
        <Image
          source={{ uri: iconSrc }}
          style={styles.favicon}
          onError={() => setIconFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text style={styles.faviconFallback}>🔗</Text>
      )}
      <Text style={styles.chipText} numberOfLines={1}>
        {safeTitle(citation.title)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: SPACING.xs + 2,
    paddingVertical: SPACING.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs + 2,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: DENSITY.chip_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface,
  },
  favicon: {
    width: 14,
    height: 14,
    borderRadius: 3,
  },
  faviconFallback: {
    width: 14,
    height: 14,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 14,
    color: THEME.text_muted,
  },
  chipText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_secondary,
    fontWeight: '500',
  },
  pressed: { opacity: 0.6 },
});
