/**
 * @neutronai/app — in-app invite modal (M2.4).
 *
 * Two-phase single panel:
 *   - "compose": collect the invitee email, "Create link" mints it
 *     (ActivityIndicator while the parent's POST is in flight).
 *   - "ready": show the share link in a selectable mono box with a
 *     Copy button + an "Expires in …" line. The owner copies + sends
 *     it themselves (email delivery is out of scope per the brief).
 *
 * Presentational — the parent (`projects/[id]/_layout.tsx`) owns the
 * async `generateInvite()` call and feeds `submitting` / `result` /
 * `errorText` back down. The invite is bound to the entered email; the
 * accept handler enforces the email match so a forwarded link can't be
 * redeemed by anyone else.
 *
 * Tokens only (no inline magic numbers) per `lib/theme.ts`'s
 * anti-pattern guard. Matches the centered-fade-Modal pattern of
 * `TaskCreateModal`.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import { formatInviteExpiry, isValidInviteeEmail } from '../lib/invite-helpers';

export interface InviteModalResult {
  invite_url: string;
  expires_at_ms: number;
}

export interface InviteModalProps {
  open: boolean;
  /** Project display name, shown in the header. */
  projectName: string;
  /** True while the parent's generateInvite POST is in flight. */
  submitting: boolean;
  /** Set once the link is minted; flips the modal to the "ready" phase. */
  result: InviteModalResult | null;
  /** Inline error copy (e.g. server reason); null when none. */
  errorText: string | null;
  onCancel: () => void;
  onSubmit: (invitee_email: string) => void;
  /** Copy the link to the clipboard; returns whether it succeeded. */
  onCopy: (text: string) => void | Promise<void>;
  /** Wall clock for expiry formatting — injectable for tests. */
  nowMs?: number;
}

export function InviteModal({
  open,
  projectName,
  submitting,
  result,
  errorText,
  onCancel,
  onSubmit,
  onCopy,
  nowMs,
}: InviteModalProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset local state whenever the modal closes so a reopen starts clean.
  useEffect(() => {
    if (!open) {
      setEmail('');
      setCopied(false);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = email.trim();
  const canSubmit = isValidInviteeEmail(trimmed) && !submitting;
  const phase: 'compose' | 'ready' = result === null ? 'compose' : 'ready';

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  const copy = (): void => {
    if (result === null) return;
    setCopied(true);
    void onCopy(result.invite_url);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.panel} testID="invite-modal">
          <Text style={styles.title} accessibilityRole="header">
            {phase === 'compose' ? 'Invite to ' + projectName : 'Invite ready'}
          </Text>

          {phase === 'compose' ? (
            <>
              <Text style={styles.subtitle}>
                Enter their email — you&apos;ll get a private link to send them.
              </Text>
              <TextInput
                accessibilityLabel="Invitee email"
                placeholder="name@example.com"
                placeholderTextColor={theme.text_muted}
                value={email}
                onChangeText={setEmail}
                style={styles.input}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                maxLength={320}
                testID="invite-email-input"
                onSubmitEditing={submit}
              />
              {errorText !== null ? (
                <Text style={styles.error} testID="invite-error">
                  {errorText}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel invite"
                  onPress={onCancel}
                  style={({ pressed }) => [styles.btn, styles.btnNeutral, pressed && styles.btnPressed]}
                  testID="invite-cancel"
                >
                  <Text style={[styles.btnText, styles.btnTextNeutral]}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Create invite link"
                  disabled={!canSubmit}
                  onPress={submit}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnPrimary,
                    !canSubmit && styles.btnDisabled,
                    canSubmit && pressed && styles.btnPressed,
                  ]}
                  testID="invite-submit"
                >
                  {submitting ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={[styles.btnText, styles.btnTextPrimary]}>Create link</Text>
                  )}
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>Send this link to your collaborator.</Text>
              <View style={styles.linkBox}>
                <Text
                  style={styles.linkText}
                  selectable
                  numberOfLines={3}
                  testID="invite-link"
                >
                  {result?.invite_url}
                </Text>
              </View>
              <Text style={styles.expiry} testID="invite-expiry">
                {result !== null
                  ? formatInviteExpiry(result.expires_at_ms, nowMs ?? Date.now())
                  : ''}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done"
                  onPress={onCancel}
                  style={({ pressed }) => [styles.btn, styles.btnNeutral, pressed && styles.btnPressed]}
                  testID="invite-done"
                >
                  <Text style={[styles.btnText, styles.btnTextNeutral]}>Done</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy invite link"
                  onPress={copy}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnPrimary,
                    pressed && styles.btnPressed,
                  ]}
                  testID="invite-copy"
                >
                  <Text style={[styles.btnText, styles.btnTextPrimary]}>
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const LINK_MIN_HEIGHT = 56;

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACING.xl,
    },
    panel: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: theme.surface,
      borderRadius: DENSITY.bubble_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      padding: SPACING.lg,
      gap: SPACING.sm,
    },
    title: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h2.fontSize,
      lineHeight: TYPOGRAPHY.h2.lineHeight,
      fontWeight: TYPOGRAPHY.h2.fontWeight,
    },
    subtitle: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
    },
    input: {
      color: theme.text_primary,
      backgroundColor: theme.background,
      borderColor: theme.hairline,
      borderWidth: 1,
      borderRadius: DENSITY.composer_radius,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    error: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
    },
    linkBox: {
      backgroundColor: theme.background,
      borderColor: theme.hairline,
      borderWidth: 1,
      borderRadius: DENSITY.composer_radius,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      minHeight: LINK_MIN_HEIGHT,
      justifyContent: 'center',
    },
    linkText: {
      color: theme.link,
      fontSize: TYPOGRAPHY.mono.fontSize,
      lineHeight: TYPOGRAPHY.mono.lineHeight,
      fontFamily: TYPOGRAPHY.mono.fontFamily,
    },
    expiry: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      letterSpacing: 0.3,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: SPACING.sm,
      marginTop: SPACING.xs,
    },
    btn: {
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.sm + 2,
      borderRadius: DENSITY.bubble_radius - 4,
      minWidth: 96,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnPressed: { opacity: 0.78 },
    btnDisabled: { opacity: 0.5 },
    btnNeutral: { backgroundColor: theme.surface_raised },
    btnPrimary: { backgroundColor: theme.text_primary },
    btnText: {
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
      fontWeight: '600',
    },
    btnTextNeutral: { color: theme.text_secondary },
    btnTextPrimary: { color: theme.background },
  });
