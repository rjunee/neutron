/**
 * @neutronai/app — launcher long-press action sheet (P5.3).
 *
 * Centered Modal-overlay action sheet. Renders, in order:
 *
 *   1. Manifest long_press_menu rows (ISSUE #17 closure) — when the
 *      Core declares `long_press_menu` on its `LAUNCHER_ICON` module,
 *      each entry is dispatched per its `action` verb
 *      (open_app_tab / chat_send / chat_send_prefix). Rendered with
 *      `testID='launcher-action-long-press-<id>'` so the smoke test
 *      can assert the row.
 *   2. The fixed system actions (Rename / Edit-disabled / Update-
 *      disabled / Move ← / Move → / Delete) plus a Cancel row.
 *
 * Edit and Update are disabled placeholders pending P9 code-gen —
 * they exist as menu rows so the affordance is visible (per spec's
 * "rename / edit / update / delete" enumeration). Move ← disabled
 * when `index === 0`; Move → disabled when `index === total - 1`.
 *
 * Per § 4.4 + § 4.11 — theme tokens only, no inline magic numbers.
 * AA contrast on every row + on the destructive (Delete) row tint.
 */

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type {
  LauncherEntry,
  LauncherEntryLongPressEntry,
} from '../lib/launcher-client';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface LauncherItemMenuTarget {
  entry: LauncherEntry;
  index: number;
}

export interface LauncherItemMenuProps {
  menu: LauncherItemMenuTarget | null;
  total: number;
  onClose: () => void;
  onRename: (entry: LauncherEntry) => void;
  onDelete: (entry: LauncherEntry) => void;
  onMoveLeft: (entry: LauncherEntry, index: number) => void;
  onMoveRight: (entry: LauncherEntry, index: number) => void;
  /** ISSUE #17 — dispatch a manifest-declared long-press menu entry.
   *  Receives the parent launcher's `entry` (for routing context) and
   *  the long-press row's payload. The parent decides routing per
   *  the row's `action` verb. */
  onLongPressEntry?: (
    entry: LauncherEntry,
    item: LauncherEntryLongPressEntry,
  ) => void;
}

export function LauncherItemMenu({
  menu,
  total,
  onClose,
  onRename,
  onDelete,
  onMoveLeft,
  onMoveRight,
  onLongPressEntry,
}: LauncherItemMenuProps) {
  if (menu === null) return null;
  const { entry, index } = menu;
  const canMoveLeft = index > 0;
  const canMoveRight = index < total - 1;
  const longPressItems = entry.long_press_menu ?? [];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close action sheet"
        onPress={onClose}
        style={styles.modalBackdrop}
      >
        <Pressable
          accessibilityRole="menu"
          onPress={() => {
            /* swallow backdrop bubble */
          }}
          style={styles.actionSheet}
          testID="launcher-action-sheet"
        >
          <Text style={styles.actionSheetTitle}>{entry.display_name}</Text>
          <Text style={styles.actionSheetSubtitle}>{entry.slug}</Text>

          {longPressItems.length > 0 ? (
            <View style={styles.longPressGroup} testID="launcher-long-press-group">
              {longPressItems.map((item) => (
                <ActionRow
                  key={item.id}
                  label={item.label}
                  testID={`launcher-action-long-press-${item.id}`}
                  onPress={() => {
                    if (onLongPressEntry !== undefined) onLongPressEntry(entry, item);
                  }}
                />
              ))}
              <View style={styles.longPressDivider} />
            </View>
          ) : null}

          <ActionRow
            label="Rename"
            testID="launcher-action-rename"
            onPress={() => onRename(entry)}
          />
          <ActionRow label="Edit" disabled disabledHint="Coming soon" onPress={noop} />
          <ActionRow label="Update" disabled disabledHint="Coming soon" onPress={noop} />
          <ActionRow
            label="Move ←"
            disabled={!canMoveLeft}
            onPress={() => onMoveLeft(entry, index)}
          />
          <ActionRow
            label="Move →"
            disabled={!canMoveRight}
            onPress={() => onMoveRight(entry, index)}
          />
          <ActionRow
            label="Delete"
            destructive
            testID="launcher-action-delete"
            onPress={() => onDelete(entry)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="launcher-action-cancel"
            onPress={onClose}
            style={({ pressed }) => [styles.cancelRow, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface ActionRowProps {
  label: string;
  onPress: () => void;
  testID?: string;
  destructive?: boolean;
  disabled?: boolean;
  disabledHint?: string;
}

function noop(): void {}

function ActionRow({
  label,
  onPress,
  testID,
  destructive = false,
  disabled = false,
  disabledHint,
}: ActionRowProps) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={disabled ? noop : onPress}
      style={({ pressed }) => [
        styles.actionRow,
        destructive && styles.actionRowDestructive,
        disabled && styles.actionRowDisabled,
        !disabled && pressed && styles.pressed,
      ]}
      {...(testID !== undefined ? { testID } : {})}
    >
      <Text
        style={[
          styles.actionRowText,
          destructive && styles.actionRowTextDestructive,
          disabled && styles.actionRowTextDisabled,
        ]}
      >
        {label}
      </Text>
      {disabled && disabledHint !== undefined ? (
        <Text style={styles.actionRowHint}>{disabledHint}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  actionSheet: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: THEME.surface,
    borderRadius: DENSITY.bubble_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  actionSheetTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h4.fontSize,
    lineHeight: TYPOGRAPHY.h4.lineHeight,
    fontWeight: '700',
    paddingHorizontal: SPACING.sm,
  },
  actionSheetSubtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm,
    fontStyle: 'italic',
  },
  actionRow: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: DENSITY.banner_radius,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
  },
  actionRowDestructive: { backgroundColor: `${THEME.danger}1a` /* THEME.danger @ ~10% alpha */ },
  actionRowDisabled: { opacity: 0.5 },
  actionRowText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '500',
  },
  actionRowTextDestructive: { color: THEME.danger },
  actionRowTextDisabled: { color: THEME.text_muted },
  actionRowHint: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontStyle: 'italic',
  },
  longPressGroup: {
    gap: SPACING.xs,
  },
  longPressDivider: {
    height: 1,
    backgroundColor: THEME.hairline,
    marginVertical: SPACING.xs,
  },
  cancelRow: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    marginTop: SPACING.xs,
    backgroundColor: THEME.surface_raised,
    borderRadius: DENSITY.banner_radius,
    alignItems: 'center',
    minHeight: 48,
  },
  cancelText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});
