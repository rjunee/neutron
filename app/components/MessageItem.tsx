/**
 * @neutronai/app — single chat message renderer (P5.1).
 *
 * Pure props in / pure JSX out. The parent (the route shell) wires
 * `onChoose`, `onDocRef`, and `onRetry` via the chat-state context.
 *
 * Three message kinds:
 *   - `system`: small italic line centered in the column (connection
 *     events, dev-token hints, error breadcrumbs).
 *   - `user`: right-aligned bubble with the locked accent-on-text
 *     palette. When `pending`, shows a soft pulse; when `failed`,
 *     shows the inline retry affordance.
 *   - `agent`: left-aligned bubble with the markdown subset render,
 *     attached images, inline citations (as chips), doc references,
 *     and the button-primitive row. When `streaming`, a soft pulsing
 *     cursor appears at the end of the body.
 */

import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { AttachmentAuthCtx } from '../lib/attachment-url';
import { AuthedAttachmentImage } from './AuthedAttachmentImage';
import { ButtonOptionRow, ImageGalleryRow } from '../lib/button-primitives';
import { CitationChipRow } from '../lib/citation-chip-row';
import type { ChatMessage } from '../lib/chat-streaming';
import { RenderMarkdown } from '../lib/markdown-render';
import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import type { AppWsOutboundAgentMessageDocRef } from '../lib/ws-envelope';

export interface MessageItemProps {
  msg: ChatMessage;
  onChoose: (value: string, prompt_id?: string) => void;
  onDocRef: (ref: AppWsOutboundAgentMessageDocRef) => void;
  onRetry: (client_msg_id: string) => void;
  /** Bearer + gateway origin used to fetch our own bearer-authed
   *  attachments (`/api/app/upload/…`). `null`/omitted when there is no
   *  session — non-authed URLs still render. */
  auth?: AttachmentAuthCtx | null;
}

export function MessageItem({ msg, onChoose, onDocRef, onRetry, auth = null }: MessageItemProps) {
  if (msg.kind === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{msg.body}</Text>
      </View>
    );
  }
  const isUser = msg.kind === 'user';
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAgent]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAgent,
          msg.pending === true && styles.bubblePending,
        ]}
      >
        {isUser ? (
          <Text style={styles.userBody}>{msg.body}</Text>
        ) : (
          <View>
            <RenderMarkdown
              source={msg.body}
              textColor={THEME.text_primary}
            />
            {msg.streaming ? <StreamingCursor /> : null}
          </View>
        )}
        {msg.attachments !== undefined && msg.attachments.length > 0 ? (
          <View style={styles.attachments}>
            {msg.attachments.map((url) => (
              <AuthedAttachmentImage key={url} url={url} auth={auth} style={styles.attachment} />
            ))}
          </View>
        ) : null}
        {msg.image_urls !== undefined && msg.image_urls.length > 0 ? (
          <View style={styles.attachments}>
            {msg.image_urls.map((url) => (
              <AuthedAttachmentImage key={url} url={url} auth={auth} style={styles.attachment} />
            ))}
          </View>
        ) : null}
        {msg.citations !== undefined && msg.citations.length > 0 ? (
          <CitationChipRow citations={msg.citations} />
        ) : null}
        {msg.doc_refs !== undefined && msg.doc_refs.length > 0 ? (
          <View style={styles.docRefs} testID="msg-doc-refs">
            <Text style={styles.docRefsHeading}>Linked docs</Text>
            {msg.doc_refs.map((ref) => (
              <Pressable
                key={ref.url}
                accessibilityRole="link"
                accessibilityLabel={ref.label}
                testID={`doc-ref-${ref.path}`}
                onPress={() => onDocRef(ref)}
                style={({ pressed }) => [styles.docRefBtn, pressed && styles.pressed]}
              >
                <Text style={styles.docRefIcon}>📄</Text>
                <View style={styles.docRefTextCol}>
                  <Text style={styles.docRefLabel} numberOfLines={1}>
                    {ref.label}
                  </Text>
                  <Text style={styles.docRefPath} numberOfLines={1}>
                    {ref.project_id === null
                      ? `vault: ${ref.path}`
                      : `${ref.project_id} · ${ref.path}`}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
        {msg.options !== undefined && msg.options.length > 0 ? (
          msg.prompt_kind === 'image-gallery' ? (
            <ImageGalleryRow
              options={msg.options}
              {...(msg.prompt_id !== undefined ? { prompt_id: msg.prompt_id } : {})}
              {...(msg.chosen_value !== undefined ? { chosen_value: msg.chosen_value } : {})}
              onChoose={onChoose}
            />
          ) : (
            <ButtonOptionRow
              options={msg.options}
              {...(msg.prompt_id !== undefined ? { prompt_id: msg.prompt_id } : {})}
              {...(msg.chosen_value !== undefined ? { chosen_value: msg.chosen_value } : {})}
              onChoose={onChoose}
            />
          )
        ) : null}
      </View>
      {isUser && msg.failed === true && msg.client_msg_id !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry send"
          onPress={() => onRetry(msg.client_msg_id!)}
          style={({ pressed }) => [styles.retryRow, pressed && styles.pressed]}
        >
          <Text style={styles.retryText}>↻ Failed — tap to retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function StreamingCursor() {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: MOTION.pulse / 2,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: MOTION.pulse / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  const animStyle = { opacity } as unknown as StyleProp<ViewStyle>;
  return (
    <Animated.Text accessibilityLabel="streaming" style={[styles.cursor, animStyle]}>
      ▌
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'column',
    marginBottom: SPACING.sm,
  },
  rowUser: { alignItems: 'flex-end' },
  rowAgent: { alignItems: 'flex-start' },
  bubble: {
    maxWidth: DENSITY.bubble_max_width,
    borderRadius: DENSITY.bubble_radius,
    paddingHorizontal: SPACING.md + 2,
    paddingVertical: SPACING.sm + 2,
  },
  bubbleUser: {
    backgroundColor: THEME.accent,
  },
  bubbleAgent: {
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  bubblePending: {
    opacity: 0.7,
  },
  userBody: {
    ...TYPOGRAPHY.body,
    color: THEME.background,
  },
  systemRow: {
    alignSelf: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: THEME.surface_raised,
    borderRadius: 10,
    marginVertical: SPACING.xs,
  },
  systemText: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    fontStyle: 'italic',
  },
  attachments: {
    marginTop: SPACING.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs + 2,
  },
  attachment: {
    width: 96,
    height: 96,
    borderRadius: 8,
    backgroundColor: THEME.surface_raised,
  },
  docRefs: { marginTop: SPACING.sm + 2, gap: SPACING.xs + 2 },
  docRefsHeading: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  docRefBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: THEME.background,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  docRefIcon: { fontSize: 16 },
  docRefTextCol: { flex: 1, gap: 1 },
  docRefLabel: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_secondary,
    fontWeight: '600',
  },
  docRefPath: { ...TYPOGRAPHY.caption, color: THEME.text_muted },
  cursor: {
    ...TYPOGRAPHY.body,
    color: THEME.text_primary,
  },
  retryRow: {
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  retryText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.danger,
    fontWeight: '600',
  },
  pressed: { opacity: 0.6 },
});
