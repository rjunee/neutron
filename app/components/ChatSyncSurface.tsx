/**
 * @neutronai/app — Telegram-grade chat surface on FlashList v2 (research doc
 * §6 Phase 2). A cohesive screen that renders the chat-core local store via
 * {@link useMobileChat}:
 *
 *   - message list on FlashList v2 (Shopify, MIT). v2 deprecated the buggy
 *     `inverted` prop (issue #1844) — we instead keep data in chronological
 *     order and pin to the bottom with
 *     `maintainVisibleContentPosition.startRenderingFromBottom`, which is the
 *     primitive FlashList v2 ships for chat (smooth, no jump on prepend);
 *   - optimistic, offline-safe send (the bubble appears instantly, with a
 *     pending clock; the queue flushes on reconnect);
 *   - per-message delivery ladder (🕓 pending → ✓ sent → ✓✓ delivered);
 *   - a live streaming/typing bubble assembled from `agent_message_partial`s;
 *   - a connection status strip driven by the chat-core WS client.
 *
 * All chat logic lives in chat-core + `chat-render-model`; this file is
 * presentation only.
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';

import type { ConnStatus } from '@neutron/chat-core';

import {
  deliveryGlyph,
  deliveryState,
  type RenderRow,
} from '../lib/chat-core/chat-render-model';
import { useMobileChat } from '../lib/chat-core/use-mobile-chat';
import { SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface ChatSyncSurfaceProps {
  /** The project this chat is scoped to (empty string = global transcript). */
  projectId: string;
}

export function ChatSyncSurface({ projectId }: ChatSyncSurfaceProps): React.JSX.Element {
  const { rows, status, typing, pendingCount, ready, send } = useMobileChat(projectId);

  const renderItem = useCallback(
    ({ item }: { item: RenderRow }) => <ChatRow row={item} />,
    [],
  );

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusStrip status={status} pendingCount={pendingCount} />
      {!ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={THEME.accent} />
        </View>
      ) : (
        <FlashList
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyForRow}
          contentContainerStyle={styles.listContent}
          // FlashList v2 chat config: keep chronological data + pin to bottom.
          // (`inverted` is deprecated in v2 and mis-scrolls paginated chat.)
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          ListFooterComponent={typing ? <TypingIndicator /> : null}
          ListEmptyComponent={<EmptyState />}
        />
      )}
      <Composer onSend={send} />
    </KeyboardAvoidingView>
  );
}

function keyForRow(row: RenderRow): string {
  return row.key;
}

/** One message or streaming bubble. */
function ChatRow({ row }: { row: RenderRow }): React.JSX.Element {
  if (row.kind === 'streaming') {
    return (
      <View style={[styles.bubbleWrap, styles.agentWrap]}>
        <View style={[styles.bubble, styles.agentBubble]}>
          <Text style={styles.agentText}>{row.body}</Text>
        </View>
      </View>
    );
  }

  const { message } = row;
  const isUser = message.role === 'user';
  const delivery = deliveryState(message);
  return (
    <View style={[styles.bubbleWrap, isUser ? styles.userWrap : styles.agentWrap]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.agentBubble]}>
        <Text style={isUser ? styles.userText : styles.agentText}>{message.body}</Text>
        {delivery !== null ? (
          <Text style={styles.delivery} accessibilityLabel={`delivery: ${delivery}`}>
            {deliveryGlyph(delivery)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function TypingIndicator(): React.JSX.Element {
  return (
    <View style={[styles.bubbleWrap, styles.agentWrap]}>
      <View style={[styles.bubble, styles.agentBubble, styles.typingBubble]}>
        <Text style={styles.typingText}>•••</Text>
      </View>
    </View>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyText}>No messages yet. Say hello 👋</Text>
    </View>
  );
}

/** Connection + offline-queue strip. Hidden when fully connected + flushed. */
function StatusStrip({
  status,
  pendingCount,
}: {
  status: ConnStatus;
  pendingCount: number;
}): React.JSX.Element | null {
  const label = statusLabel(status, pendingCount);
  if (label === null) return null;
  const tone = status === 'open' ? THEME.text_muted : THEME.warning;
  return (
    <View style={styles.statusStrip}>
      <Text style={[styles.statusText, { color: tone }]}>{label}</Text>
    </View>
  );
}

function statusLabel(status: ConnStatus, pendingCount: number): string | null {
  if (status === 'open') {
    return pendingCount > 0 ? `Sending ${pendingCount}…` : null;
  }
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return pendingCount > 0 ? `Offline — ${pendingCount} queued` : 'Reconnecting…';
    case 'closed':
      return 'Disconnected';
    case 'idle':
      return null;
  }
}

function Composer({ onSend }: { onSend: (body: string) => void }): React.JSX.Element {
  const [text, setText] = useState('');
  const submit = useCallback(() => {
    const body = text.trim();
    if (body.length === 0) return;
    onSend(body);
    setText('');
  }, [text, onSend]);

  const canSend = text.trim().length > 0;
  return (
    <View style={styles.composer}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message"
        placeholderTextColor={THEME.text_muted}
        multiline
        onSubmitEditing={submit}
        blurOnSubmit={false}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        onPress={submit}
        disabled={!canSend}
        style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
      >
        <Text style={styles.sendBtnText}>↑</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: THEME.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  listContent: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.md },
  bubbleWrap: { marginVertical: SPACING.xs, flexDirection: 'row' },
  userWrap: { justifyContent: 'flex-end' },
  agentWrap: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 16,
  },
  userBubble: { backgroundColor: THEME.accent, borderBottomRightRadius: 4 },
  agentBubble: {
    backgroundColor: THEME.surface_raised,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
  },
  userText: { ...TYPOGRAPHY.body, color: THEME.background },
  agentText: { ...TYPOGRAPHY.body, color: THEME.text_primary },
  delivery: {
    ...TYPOGRAPHY.caption,
    color: THEME.background,
    opacity: 0.7,
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  typingBubble: { paddingVertical: SPACING.xs },
  typingText: { ...TYPOGRAPHY.h2, color: THEME.text_muted, letterSpacing: 2 },
  emptyText: { ...TYPOGRAPHY.body, color: THEME.text_muted },
  statusStrip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    backgroundColor: THEME.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: THEME.hairline,
  },
  statusText: { ...TYPOGRAPHY.caption },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: SPACING.sm,
    gap: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: THEME.hairline,
    backgroundColor: THEME.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
    backgroundColor: THEME.surface_raised,
    color: THEME.text_primary,
    ...TYPOGRAPHY.body,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.accent,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { ...TYPOGRAPHY.h3, color: THEME.background, fontWeight: '700' },
});
