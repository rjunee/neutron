/**
 * @neutronai/app — project-scoped backups + restore surface (P7.4 restore UI).
 *
 * Reachable from `<ProjectSettingsDrawer>` → "Backups & restore". Renders
 * three layered views:
 *
 *   1. The day-bucketed snapshot list (newest first; collapsible
 *      day-headers; per-row size / change-count).
 *   2. A snapshot-preview modal mounted on tap: file tree with
 *      add/modify/delete badges, a per-file diff drawer, and the
 *      restore actions (whole-project / single-file).
 *   3. A confirmation modal for every restore destructive action, with
 *      a stark warning copy and explicit Cancel / Restore buttons.
 *
 * After a restore lands, a bottom-anchored undo banner pins for the
 * configured visibility window (default 24 hours; clearable via the
 * banner's dismiss button). Undo triggers a second restore back to
 * `prior_head_sha` recorded in the recovery commit's metadata.
 *
 * Design: every visual token sources from `lib/theme.ts`. No new
 * "danger" / "warning" colors are introduced — the existing
 * `THEME.danger` + `THEME.warning` cover destructive copy. No
 * bouncy / elastic easing on the banner enter/exit — only the
 * `Easing.out(quad)` / `Easing.in(quad)` curves the rest of the app
 * uses.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { loadAppConfig } from '../../../lib/config';
import { useAuthSession } from '../../../lib/session';
import {
  BREAKPOINTS,
  MOTION,
  SPACING,
  THEME,
  TYPOGRAPHY,
} from '../../../lib/composer-constants';
import {
  BackupsClient,
  BackupsClientError,
  formatRelativeTime,
  groupSnapshotsByDay,
  type RestoreResult,
  type SnapshotFile,
  type SnapshotFileDiff,
  type SnapshotPreview,
  type SnapshotSummary,
} from '../../../lib/backups-client';

/** How long the undo banner stays mounted after a successful restore. */
export const UNDO_BANNER_MS = 24 * 60 * 60 * 1000;

interface UndoState {
  /** Snapshot sha that the user just restored to. */
  restored_to: string;
  /** Prior HEAD captured by the server in the recovery commit. */
  prior_head_sha: string;
  /** Path that was restored, or null for a whole-project restore. */
  file_path: string | null;
  /** Wall-clock ms when the restore landed. */
  completed_at_ms: number;
}

export default function BackupsTab(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const client = useMemo(() => {
    if (user === null) return null;
    return new BackupsClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= BREAKPOINTS.narrow_max;
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [previewSha, setPreviewSha] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | null
    | {
        snapshot_sha: string;
        file_path: string | null;
        short_message: string;
      }
  >(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    setError(null);
    try {
      const page = await client.listSnapshots(project_id, { limit: 120 });
      setSnapshots(page.snapshots);
      setNow(Date.now());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [client, project_id]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Drop the undo banner once it ages past the visibility window.
  // We tick once per minute so the banner self-clears even when the
  // user leaves the screen mounted.
  useEffect(() => {
    if (undo === null) return undefined;
    const t = setInterval(() => {
      const age = Date.now() - undo.completed_at_ms;
      if (age >= UNDO_BANNER_MS) setUndo(null);
    }, 60_000);
    return () => clearInterval(t);
  }, [undo]);

  const toggleDay = useCallback((day_iso: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(day_iso)) {
        next.delete(day_iso);
      } else {
        next.add(day_iso);
      }
      return next;
    });
  }, []);

  const handleRestore = useCallback(
    async (snapshot_sha: string, file_path: string | null) => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        const result: RestoreResult = await client.restore(
          project_id,
          snapshot_sha,
          file_path,
        );
        setUndo({
          restored_to: result.snapshot_sha,
          prior_head_sha: result.prior_head_sha,
          file_path: result.file_path,
          completed_at_ms: result.completed_at_ms,
        });
        setConfirm(null);
        setPreviewSha(null);
        await fetchAll();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, project_id, fetchAll],
  );

  const handleUndo = useCallback(async () => {
    if (client === null || undo === null) return;
    setUndoBusy(true);
    setError(null);
    try {
      const result = await client.restore(
        project_id,
        undo.prior_head_sha,
        undo.file_path,
      );
      // Once the undo lands we leave the banner up but rotate it to
      // point at the NEW restore — the user can keep peeling restores
      // back until they reach a state they're happy with.
      setUndo({
        restored_to: result.snapshot_sha,
        prior_head_sha: result.prior_head_sha,
        file_path: result.file_path,
        completed_at_ms: result.completed_at_ms,
      });
      await fetchAll();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setUndoBusy(false);
    }
  }, [client, project_id, undo, fetchAll]);

  // Argus r1 MINOR — hooks must be called unconditionally on every
  // render, so this useMemo lives ABOVE the route-guard early return.
  // (Previously the guard at `project_id.length === 0` returned first,
  // making this hook conditional and violating the rules of hooks —
  // see https://react.dev/reference/rules/rules-of-hooks.)
  const groups = useMemo(
    () => groupSnapshotsByDay(snapshots, now),
    [snapshots, now],
  );

  if (project_id.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorBanner}>No project id in route params.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="backups-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="backups-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerBtnText}>← Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Project</Text>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Backups & restore
          </Text>
        </View>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.intro}>
          <Text style={styles.bodyText}>
            Every six hours this project is snapshotted into a hidden{' '}
            <Text style={styles.mono}>.project-backup/</Text> repo. Tap a row
            to preview what changed; tap Restore to roll the working tree
            back to that snapshot. Restores are themselves committed, so a
            wrong choice is recoverable.
          </Text>
        </View>
        {error !== null ? (
          <Text style={styles.errorBanner} testID="backups-error">
            {error}
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={THEME.text_secondary} />
          </View>
        ) : snapshots.length === 0 ? (
          <Text style={styles.emptyState} testID="backups-empty">
            No snapshots yet — the next scheduled tick (or a manual{' '}
            <Text style={styles.mono}>Run backup now</Text> from the admin
            backup tab) will create the first one.
          </Text>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.day_iso);
            return (
              <View key={group.day_iso} style={styles.dayBlock}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${group.label}, ${group.snapshots.length} snapshots, ${isCollapsed ? 'collapsed' : 'expanded'}`}
                  testID={`backups-day-${group.day_iso}`}
                  onPress={() => toggleDay(group.day_iso)}
                  style={({ pressed }) => [
                    styles.dayHeaderRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.dayHeaderLabel}>{group.label}</Text>
                  <Text style={styles.dayHeaderCount}>
                    {group.snapshots.length}{' '}
                    {group.snapshots.length === 1 ? 'snapshot' : 'snapshots'}
                    {' · '}
                    {isCollapsed ? '+' : '−'}
                  </Text>
                </Pressable>
                {!isCollapsed
                  ? group.snapshots.map((snap) => (
                      <SnapshotRow
                        key={snap.sha}
                        snap={snap}
                        now={now}
                        onPress={() => setPreviewSha(snap.sha)}
                      />
                    ))
                  : null}
              </View>
            );
          })
        )}
      </ScrollView>

      <PreviewModal
        client={client}
        project_id={project_id}
        sha={previewSha}
        onClose={() => setPreviewSha(null)}
        onRequestRestore={(file_path, short_message) => {
          if (previewSha === null) return;
          setConfirm({ snapshot_sha: previewSha, file_path, short_message });
        }}
        wide={wide}
      />

      <ConfirmRestoreModal
        confirm={confirm}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === null) return;
          void handleRestore(confirm.snapshot_sha, confirm.file_path);
        }}
      />

      <UndoBanner
        undo={undo}
        busy={undoBusy}
        now={now}
        onUndo={() => void handleUndo()}
        onDismiss={() => setUndo(null)}
      />
    </View>
  );
}

function SnapshotRow({
  snap,
  now,
  onPress,
}: {
  snap: SnapshotSummary;
  now: number;
  onPress: () => void;
}) {
  const stat = snap.shortstat;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Snapshot ${snap.sha.slice(0, 7)}, ${snap.message}`}
      testID={`backups-row-${snap.sha}`}
      onPress={onPress}
      style={({ pressed }) => [styles.snapshotRow, pressed && styles.pressed]}
    >
      <View style={styles.snapshotRowText}>
        <Text style={styles.snapshotMessage} numberOfLines={1}>
          {snap.message}
        </Text>
        <Text style={styles.snapshotMeta}>
          {formatRelativeTime(snap.author_date, now)}
          {' · '}
          <Text style={styles.mono}>{snap.sha.slice(0, 7)}</Text>
          {stat !== null && stat.files_changed > 0 ? (
            <>
              {' · '}
              {stat.files_changed}{' '}
              {stat.files_changed === 1 ? 'file' : 'files'}
              {stat.insertions > 0 ? ` +${stat.insertions}` : ''}
              {stat.deletions > 0 ? ` −${stat.deletions}` : ''}
            </>
          ) : null}
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function PreviewModal({
  client,
  project_id,
  sha,
  onClose,
  onRequestRestore,
  wide,
}: {
  client: BackupsClient | null;
  project_id: string;
  sha: string | null;
  onClose: () => void;
  onRequestRestore: (file_path: string | null, short_message: string) => void;
  wide: boolean;
}) {
  const [preview, setPreview] = useState<SnapshotPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<SnapshotFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Reset internal state on every snapshot switch.
  useEffect(() => {
    if (sha === null) {
      setPreview(null);
      setPreviewError(null);
      setOpenedFile(null);
      setDiff(null);
      return;
    }
    if (client === null) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setOpenedFile(null);
    setDiff(null);
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.previewSnapshot(project_id, sha);
        if (!cancelled) {
          setPreview(result);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewError(formatError(err));
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, project_id, sha]);

  useEffect(() => {
    if (openedFile === null || sha === null || client === null) {
      setDiff(null);
      return undefined;
    }
    setDiffLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.getSnapshotDiff(project_id, sha, openedFile);
        if (!cancelled) {
          setDiff(result);
        }
      } catch (err) {
        if (!cancelled) {
          setDiff({
            sha,
            path: openedFile,
            hunks: `(diff load failed — ${formatError(err)})`,
            truncated: false,
          });
        }
      } finally {
        if (!cancelled) {
          setDiffLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, project_id, sha, openedFile]);

  const short_message = preview?.message ?? (sha?.slice(0, 7) ?? '');

  return (
    <Modal
      visible={sha !== null}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <View
          style={[
            styles.previewPanel,
            wide ? styles.previewPanelWide : styles.previewPanelNarrow,
          ]}
          accessibilityViewIsModal
          testID="backups-preview-modal"
        >
          <View style={styles.previewHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.previewOverline}>Snapshot</Text>
              <Text style={styles.previewTitle} numberOfLines={2}>
                {preview?.message ?? sha?.slice(0, 12) ?? ''}
              </Text>
              {preview !== null ? (
                <Text style={styles.previewSubtitle}>
                  <Text style={styles.mono}>{preview.sha.slice(0, 7)}</Text>
                  {' · '}
                  {new Date(preview.author_date).toLocaleString()}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close snapshot preview"
              testID="backups-preview-close"
              onPress={onClose}
              style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>
          {previewLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={THEME.text_secondary} />
            </View>
          ) : previewError !== null ? (
            <Text style={styles.errorBanner}>{previewError}</Text>
          ) : preview !== null ? (
            <View style={styles.previewBody}>
              <View style={styles.previewLeftPane}>
                <Text style={styles.previewSectionLabel}>
                  {preview.files.length === 0
                    ? 'No tracked changes vs current'
                    : `${preview.files.length} ${preview.files.length === 1 ? 'file changes' : 'file changes'} vs current`}
                </Text>
                <ScrollView style={styles.previewFilesScroll}>
                  {preview.files.map((f) => (
                    <FileRow
                      key={`${f.path}-${f.status}`}
                      file={f}
                      selected={openedFile === f.path}
                      onPress={() => setOpenedFile(f.path)}
                    />
                  ))}
                </ScrollView>
              </View>
              {wide ? (
                <View style={styles.previewRightPane}>
                  <Text style={styles.previewSectionLabel}>
                    {openedFile === null
                      ? 'Diff'
                      : `Diff · ${openedFile}`}
                  </Text>
                  {openedFile === null ? (
                    <Text style={styles.muted}>
                      Tap a file on the left to view its diff vs the current
                      working tree.
                    </Text>
                  ) : diffLoading ? (
                    <ActivityIndicator color={THEME.text_secondary} />
                  ) : diff !== null ? (
                    <DiffView diff={diff} />
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {preview !== null && !previewLoading ? (
            <View style={styles.previewActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Restore the whole project to this snapshot"
                testID="backups-preview-restore-project"
                onPress={() => onRequestRestore(null, short_message)}
                style={({ pressed }) => [
                  styles.dangerBtn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.dangerBtnText}>Restore whole project</Text>
              </Pressable>
              {openedFile !== null ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore only ${openedFile}`}
                  testID="backups-preview-restore-file"
                  onPress={() => onRequestRestore(openedFile, short_message)}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryBtnText}>
                    Restore this file only
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function FileRow({
  file,
  selected,
  onPress,
}: {
  file: SnapshotFile;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.path}, ${file.status}`}
      testID={`backups-file-row-${file.path}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fileRow,
        selected && styles.fileRowSelected,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.fileBadge, fileBadgeStyle(file.status)]}>
        <Text style={[styles.fileBadgeText, fileBadgeTextStyle(file.status)]}>
          {fileStatusGlyph(file.status)}
        </Text>
      </View>
      <Text style={styles.filePath} numberOfLines={1}>
        {file.path}
      </Text>
    </Pressable>
  );
}

function DiffView({ diff }: { diff: SnapshotFileDiff }) {
  if (diff.hunks.length === 0) {
    return (
      <Text style={styles.muted}>
        File unchanged between current and this snapshot.
      </Text>
    );
  }
  return (
    <ScrollView style={styles.diffScroll}>
      <View>
        {diff.hunks.split('\n').map((line, idx) => (
          <Text
            key={idx}
            style={[styles.diffLine, diffLineStyle(line)]}
            testID={`backups-diff-line-${idx}`}
          >
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
        {diff.truncated ? (
          <Text style={styles.muted}>(diff truncated)</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function ConfirmRestoreModal({
  confirm,
  busy,
  onCancel,
  onConfirm,
}: {
  confirm:
    | null
    | { snapshot_sha: string; file_path: string | null; short_message: string };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (confirm === null) return null;
  const scope = confirm.file_path === null ? 'whole project' : confirm.file_path;
  return (
    <Modal
      visible
      animationType="fade"
      transparent
      onRequestClose={busy ? () => undefined : onCancel}
    >
      <View style={styles.modalBackdrop}>
        <View
          style={styles.confirmPanel}
          accessibilityViewIsModal
          testID="backups-confirm-modal"
        >
          <Text style={styles.confirmTitle}>Confirm restore</Text>
          <Text style={styles.confirmBody}>
            Restore the{' '}
            <Text style={styles.confirmBodyEmphasis}>{scope}</Text> to snapshot{' '}
            <Text style={styles.mono}>{confirm.snapshot_sha.slice(0, 7)}</Text>?
          </Text>
          <Text style={styles.confirmWarning}>
            {confirm.file_path === null
              ? 'This will overwrite the current working tree with the snapshot. Local edits since this snapshot will be wiped, but the prior state stays reachable as a commit so you can undo.'
              : 'This will overwrite the current copy of this file with the snapshot version. Local edits to this file will be wiped; other files are untouched.'}
          </Text>
          <View style={styles.confirmActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel restore"
              testID="backups-confirm-cancel"
              disabled={busy}
              onPress={onCancel}
              style={({ pressed }) => [
                styles.secondaryBtn,
                busy && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restore"
              testID="backups-confirm-restore"
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.dangerBtn,
                busy && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.dangerBtnText}>
                {busy ? 'Restoring…' : 'Restore'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function UndoBanner({
  undo,
  busy,
  now,
  onUndo,
  onDismiss,
}: {
  undo: UndoState | null;
  busy: boolean;
  now: number;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (undo === null) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 80,
          duration: reduceMotion ? 0 : MOTION.base,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: reduceMotion ? 0 : MOTION.fast,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: reduceMotion ? 0 : MOTION.base,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: reduceMotion ? 0 : MOTION.fast,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ]).start();
  }, [undo, translateY, opacity, reduceMotion]);

  if (undo === null) return null;

  const restoredLabel =
    undo.file_path === null
      ? 'whole project'
      : undo.file_path;
  const relative = formatRelativeTime(
    new Date(undo.completed_at_ms).toISOString(),
    now,
  );
  return (
    <Animated.View
      style={[
        styles.undoBanner,
        { transform: [{ translateY }], opacity },
      ]}
      accessibilityRole="alert"
      testID="backups-undo-banner"
    >
      <View style={styles.undoBannerBody}>
        <Text style={styles.undoBannerLabel}>
          Restored {restoredLabel} from{' '}
          <Text style={styles.mono}>{undo.restored_to.slice(0, 7)}</Text>
          {' · '}
          {relative}
        </Text>
        <View style={styles.undoBannerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo restore"
            testID="backups-undo-action"
            disabled={busy}
            onPress={onUndo}
            style={({ pressed }) => [
              styles.undoActionBtn,
              busy && styles.btnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.undoActionBtnText}>
              {busy ? 'Undoing…' : 'Undo'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss banner"
            testID="backups-undo-dismiss"
            onPress={onDismiss}
            style={({ pressed }) => [
              styles.undoDismissBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.undoDismissText}>✕</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

function fileStatusGlyph(status: SnapshotFile['status']): string {
  switch (status) {
    case 'added':
      return '+';
    case 'modified':
      return '~';
    case 'deleted':
      return '−';
    case 'unchanged':
      return '·';
    default:
      return '?';
  }
}

function fileBadgeStyle(status: SnapshotFile['status']) {
  switch (status) {
    case 'added':
      return styles.fileBadgeAdded;
    case 'deleted':
      return styles.fileBadgeDeleted;
    case 'modified':
      return styles.fileBadgeModified;
    default:
      return styles.fileBadgeNeutral;
  }
}

function fileBadgeTextStyle(status: SnapshotFile['status']) {
  switch (status) {
    case 'added':
      return styles.fileBadgeTextAdded;
    case 'deleted':
      return styles.fileBadgeTextDeleted;
    case 'modified':
      return styles.fileBadgeTextModified;
    default:
      return styles.fileBadgeTextNeutral;
  }
}

function diffLineStyle(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return styles.diffAdd;
  if (line.startsWith('-') && !line.startsWith('---')) return styles.diffDel;
  if (line.startsWith('@@')) return styles.diffHunk;
  return styles.diffContext;
}

function formatError(err: unknown): string {
  if (err instanceof BackupsClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingTop: SPACING.xxl + SPACING.lg,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  headerBtn: { minWidth: 64 },
  headerBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '500',
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerOverline: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  headerTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  scroll: {
    padding: SPACING.lg,
    paddingBottom: 120,
    gap: SPACING.md,
  },
  intro: { gap: SPACING.sm },
  bodyText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  mono: {
    fontFamily: TYPOGRAPHY.mono.fontFamily,
    color: THEME.text_secondary,
  },
  errorBanner: {
    color: THEME.danger,
    backgroundColor: '#3b1212',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
  emptyState: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  dayBlock: { gap: SPACING.xs },
  dayHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  dayHeaderLabel: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    fontWeight: '600',
  },
  dayHeaderCount: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
  },
  snapshotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    backgroundColor: THEME.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.hairline,
    gap: SPACING.sm,
  },
  snapshotRowText: { flex: 1, gap: 2 },
  snapshotMessage: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '500',
  },
  snapshotMeta: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
  },
  chevron: { color: THEME.text_muted, fontSize: 18, fontWeight: '300' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  previewPanel: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.hairline,
    overflow: 'hidden',
  },
  previewPanelNarrow: { width: '100%', maxHeight: '90%' },
  previewPanelWide: { width: '90%', maxWidth: 920, maxHeight: '90%' },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: SPACING.lg,
    gap: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  previewOverline: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  previewTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  previewSubtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  closeGlyph: { color: THEME.text_secondary, fontSize: 18 },
  previewBody: {
    flexDirection: 'row',
    flex: 1,
    minHeight: 240,
  },
  previewLeftPane: {
    width: 280,
    padding: SPACING.md,
    gap: SPACING.sm,
    borderRightWidth: 1,
    borderRightColor: THEME.hairline,
  },
  previewRightPane: {
    flex: 1,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  previewSectionLabel: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  previewFilesScroll: { maxHeight: 360 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
    gap: SPACING.sm,
  },
  fileRowSelected: { backgroundColor: THEME.surface_raised },
  filePath: {
    color: THEME.text_secondary,
    fontFamily: TYPOGRAPHY.mono.fontFamily,
    fontSize: 12,
    flex: 1,
  },
  fileBadge: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
  fileBadgeText: { fontWeight: '700', fontSize: 12 },
  fileBadgeAdded: { backgroundColor: '#0f2418' },
  fileBadgeTextAdded: { color: '#bbf7d0' },
  fileBadgeDeleted: { backgroundColor: '#3b1212' },
  fileBadgeTextDeleted: { color: '#fecaca' },
  fileBadgeModified: { backgroundColor: '#1f2937' },
  fileBadgeTextModified: { color: '#bfdbfe' },
  fileBadgeNeutral: { backgroundColor: THEME.hairline },
  fileBadgeTextNeutral: { color: THEME.text_muted },
  diffScroll: { maxHeight: 360 },
  diffLine: {
    fontFamily: TYPOGRAPHY.mono.fontFamily,
    fontSize: 12,
    lineHeight: 16,
  },
  diffAdd: { color: '#bbf7d0' },
  diffDel: { color: '#fecaca' },
  diffHunk: { color: '#bfdbfe' },
  diffContext: { color: THEME.text_secondary },
  previewActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: THEME.hairline,
  },
  dangerBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md - SPACING.xs / 2,
    borderRadius: 10,
    backgroundColor: '#7f1d1d',
  },
  dangerBtnText: {
    color: '#fff',
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
  },
  secondaryBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md - SPACING.xs / 2,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '500',
  },
  btnDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  confirmPanel: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: SPACING.lg,
    gap: SPACING.md,
    width: '100%',
    maxWidth: 420,
  },
  confirmTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  confirmBody: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  confirmBodyEmphasis: { color: THEME.text_primary, fontWeight: '600' },
  confirmWarning: {
    color: '#fecaca',
    backgroundColor: '#3b1212',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  confirmActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  undoBanner: {
    position: 'absolute',
    bottom: SPACING.lg,
    left: SPACING.lg,
    right: SPACING.lg,
    backgroundColor: THEME.surface_raised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: SPACING.md,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  undoBannerBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  undoBannerLabel: {
    flex: 1,
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
  undoBannerActions: { flexDirection: 'row', gap: SPACING.xs },
  undoActionBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  undoActionBtnText: {
    color: '#0a0a0a',
    fontSize: TYPOGRAPHY.caption.fontSize,
    fontWeight: '600',
  },
  undoDismissBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
  },
  undoDismissText: {
    color: THEME.text_muted,
    fontSize: 14,
  },
  muted: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
});
