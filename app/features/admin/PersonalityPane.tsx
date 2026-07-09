/**
 * @neutronai/app — admin tab, Personality pane.
 *
 * Three-file markdown editor for `<owner_home>/persona/SOUL.md`,
 * `USER.md`, `priority-map.md`. Replaces the prior single-textarea
 * shape (PR #155) per
 * docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
 *
 * Layout:
 *   - Top: file-selector chips (SOUL / USER / priority-map). Each chip
 *     shows a •dot when its file has unsaved edits so the user knows
 *     which panes still need saving.
 *   - Middle: edit/preview toggle. On wide viewports (>= 720 px) the
 *     editor + preview render side-by-side; on narrow viewports they
 *     stack with a Editor/Preview toggle.
 *   - Per-pane Save button. Disabled when not dirty.
 *   - 409 conflict banner with a Reload button (loses the in-progress
 *     draft to fetch the canonical body) AND a Force overwrite button
 *     (sends `expected_mtime: -1`).
 *   - Bottom: Restart-from-scratch danger button + confirm modal.
 *
 * Hot-reload: every successful save fires the gateway's `onReload`
 * hook (no-op in M1 — see surface header). The next chat turn re-reads
 * from disk regardless because the system-prompt assembler has no
 * cache (runtime/system-prompt.ts:71-80).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  AdminPersonalityClient,
  AdminPersonalityClientError,
  PERSONA_FILENAMES,
  type PersonaFilename,
} from '../../lib/admin-personality-client';
import {
  buildSavePayload,
  makePerFileMutateGates,
  restartBannerKind,
  summarizeRestart,
  summarizeRestartFailure,
  type RestartStatus,
} from '../../lib/personality-pane-helpers';
import { RenderMarkdown } from '../../lib/markdown-render';
import { formatPersonaError } from './format';

type PreviewMode = 'edit' | 'preview';

interface PaneState {
  baseline: string;
  draft: string;
  mtime: number;
  saving: boolean;
  conflict: { current_mtime: number } | null;
  error: string | null;
  saved_at: number | null;
  exists: boolean;
  load_error: string | null;
}

function freshPane(): PaneState {
  return {
    baseline: '',
    draft: '',
    mtime: 0,
    saving: false,
    conflict: null,
    error: null,
    saved_at: null,
    exists: false,
    load_error: null,
  };
}

const FILE_LABELS: Record<PersonaFilename, string> = {
  'SOUL.md': 'SOUL',
  'USER.md': 'USER',
  'priority-map.md': 'priority-map',
};

const FILE_HINTS: Record<PersonaFilename, string> = {
  'SOUL.md':
    'Voice, archetypal blend, operating principles. The agent loads this every session start.',
  'USER.md':
    'Who you are — name, family, addresses, preferences. Pulled into the prompt as user facts.',
  'priority-map.md':
    'Project priorities, people tiers, auto-resolve rules vs escalation lanes.',
};

export function PersonalityPane({ client }: { client: AdminPersonalityClient }) {
  const { width } = useWindowDimensions();
  const wideViewport = width >= 720;
  const [active, setActive] = useState<PersonaFilename>('SOUL.md');
  const [panes, setPanes] = useState<Record<PersonaFilename, PaneState>>(() => ({
    'SOUL.md': freshPane(),
    'USER.md': freshPane(),
    'priority-map.md': freshPane(),
  }));
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('edit');
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<RestartStatus | null>(null);

  // Argus r2 (2026-05-22) B1 fix — synchronous mirror of `panes` so
  // saveOne can snapshot draft+mtime BEFORE the queued setPanes
  // updater fires. The prior code read the snapshot INSIDE the
  // setPanes updater and the `client.saveFile({content, ...})` call
  // then evaluated its args from a stale (pre-update) closure, sending
  // content='' and expected_mtime=0 on the wire.
  const panesRef = useRef(panes);
  panesRef.current = panes;

  // Argus r2 (2026-05-22) B2 fix — per-file RequestGates. The prior
  // single shared gate meant a Reload on USER invalidated an in-flight
  // Save on SOUL; SOUL's catch branch then bailed before clearing
  // saving=true and the pane was stuck (disabled Save + non-editable
  // TextInput). The bulk gate handles fetchAll + restart (the
  // destructive instance-wide flow gets its own lane).
  const gates = useMemo(() => makePerFileMutateGates(), []);

  const updatePane = useCallback(
    (filename: PersonaFilename, patch: Partial<PaneState>) => {
      setPanes((prev) => ({ ...prev, [filename]: { ...prev[filename], ...patch } }));
    },
    [],
  );

  const fetchAll = useCallback(async () => {
    const token = gates.bulk.acquire();
    setLoading(true);
    setTopError(null);
    try {
      // Frontend race P3-3: Promise.allSettled in parallel; one file
      // failing still surfaces per-pane load_error on that file.
      const results = await Promise.allSettled(
        PERSONA_FILENAMES.map((f) => client.getFile(f)),
      );
      if (!gates.bulk.isLatest(token)) return;
      const next: Record<PersonaFilename, PaneState> = {
        'SOUL.md': freshPane(),
        'USER.md': freshPane(),
        'priority-map.md': freshPane(),
      };
      PERSONA_FILENAMES.forEach((f, i) => {
        const r = results[i]!;
        if (r.status === 'fulfilled') {
          next[f] = {
            ...freshPane(),
            baseline: r.value.content,
            draft: r.value.content,
            mtime: r.value.mtime,
            exists: r.value.mtime > 0,
          };
        } else {
          next[f] = { ...freshPane(), load_error: formatPersonaError(r.reason) };
        }
      });
      setPanes(next);
    } catch (err) {
      if (gates.bulk.isLatest(token)) setTopError(formatPersonaError(err));
    } finally {
      if (gates.bulk.isLatest(token)) setLoading(false);
    }
  }, [client, gates]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const reloadOne = useCallback(
    async (filename: PersonaFilename) => {
      const gate = gates.files[filename];
      const token = gate.acquire();
      // Frontend race P1-2: surface a per-pane `saving` flag during
      // reload so the editor is disabled — keystrokes between Reload
      // click and resolution otherwise vanish silently.
      updatePane(filename, { saving: true, error: null });
      try {
        const body = await client.getFile(filename);
        if (!gate.isLatest(token)) return;
        updatePane(filename, {
          saving: false,
          baseline: body.content,
          draft: body.content,
          mtime: body.mtime,
          conflict: null,
          error: null,
          exists: body.mtime > 0,
        });
      } catch (err) {
        // Argus r2 B2 fix — ALWAYS clear `saving` on the targeted
        // file even when our token is stale; the prior code bailed
        // before clearing the flag and the pane was stuck disabled.
        if (gate.isLatest(token)) {
          updatePane(filename, { saving: false, error: formatPersonaError(err) });
        } else {
          updatePane(filename, { saving: false });
        }
      }
    },
    [client, gates, updatePane],
  );

  const saveOne = useCallback(
    async (filename: PersonaFilename, opts: { force?: boolean } = {}) => {
      const gate = gates.files[filename];
      const token = gate.acquire();
      // Argus r2 (2026-05-22) B1 fix — read draft+mtime SYNCHRONOUSLY
      // from panesRef BEFORE setPanes. React batches setState(updater)
      // calls, so reading the snapshot inside the updater (as r1 did)
      // means `client.saveFile({content, expected_mtime})` evaluates
      // its arg expressions against an EMPTY closure (`sent_body=''`,
      // `sent_mtime=0`) at the call site, BEFORE the updater fires.
      // The wire payload was empty; this caused silent data loss on
      // every save.
      const { sent_body, sent_mtime } = buildSavePayload(
        panesRef.current[filename],
        { force: opts.force },
      );
      updatePane(filename, { saving: true, error: null });
      try {
        const res = await client.saveFile({
          filename,
          content: sent_body,
          expected_mtime: sent_mtime,
        });
        if (!gate.isLatest(token)) return;
        // Baseline catches up to the body that was ACTUALLY on the wire
        // (sent_body) — NOT the live draft. If the user kept typing
        // mid-save, the post-save dirty flag correctly stays true vs
        // the new draft. Without this, baseline = pane.draft writes a
        // stale catch-up and the chip flickers clean for a frame.
        setPanes((prev) => ({
          ...prev,
          [filename]: {
            ...prev[filename],
            saving: false,
            baseline: sent_body,
            mtime: res.mtime,
            conflict: null,
            error: null,
            saved_at: Date.now(),
            exists: true,
          },
        }));
      } catch (err) {
        // Argus r2 B2 fix — ALWAYS clear `saving` on the targeted
        // file, even when our token is stale. The prior code returned
        // early on stale tokens, which (combined with the shared
        // mutateGate) left SOUL stuck in saving=true whenever a
        // Reload on USER fired between this save and its resolution.
        if (!gate.isLatest(token)) {
          updatePane(filename, { saving: false });
          return;
        }
        if (
          err instanceof AdminPersonalityClientError &&
          err.code === 'mtime_conflict' &&
          typeof err.current_mtime === 'number'
        ) {
          updatePane(filename, {
            saving: false,
            conflict: { current_mtime: err.current_mtime },
            error: 'File changed elsewhere — Reload or Force overwrite.',
          });
        } else {
          updatePane(filename, { saving: false, error: formatPersonaError(err) });
        }
      }
    },
    [client, gates, updatePane],
  );

  const restartFromScratch = useCallback(async () => {
    setRestarting(true);
    setRestartStatus(null);
    // Frontend race P0-2: invalidate every in-flight save/reload BEFORE
    // POSTing restart so a late save resolver can't write stale
    // baseline+mtime onto a file the server is about to delete. With
    // per-file gates (B2 fix) we must reset each lane explicitly.
    gates.resetAll();
    try {
      const result = await client.restartFromScratch();
      // Argus r2 (2026-05-22) I3 fix — track files_failed in
      // structured state so the banner colour selector can branch on
      // `files_failed.length > 0` instead of the old
      // `restartResult.startsWith('Restart failed')` string sniff (the
      // 207 partial path never matched that prefix → green-on-failure).
      setRestartStatus(summarizeRestart(result));
      setRestartConfirm(false);
      await fetchAll();
    } catch (err) {
      setRestartStatus(summarizeRestartFailure(formatPersonaError(err)));
    } finally {
      setRestarting(false);
    }
  }, [client, fetchAll, gates]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  const pane = panes[active];
  const dirty = pane.draft !== pane.baseline;

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Personality</Text>
        <Text style={styles.paneSubtitle}>
          Edit the three files the agent loads at session start. Changes write
          atomically to
          <Text style={styles.code}>{' <owner_home>/persona/'}</Text>
          and take effect on the next chat turn (no restart needed).
        </Text>
      </View>

      {topError !== null ? <Text style={styles.bannerError}>{topError}</Text> : null}

      {/* File selector chips */}
      <View style={styles.choiceRow}>
        {PERSONA_FILENAMES.map((f) => {
          const p = panes[f];
          const isActive = f === active;
          const fileDirty = p.draft !== p.baseline;
          return (
            <Pressable
              key={f}
              accessibilityRole="tab"
              accessibilityLabel={`Edit ${FILE_LABELS[f]}`}
              accessibilityState={{ selected: isActive }}
              testID={`admin-persona-tab-${f}`}
              onPress={() => setActive(f)}
              style={({ pressed }) => [
                styles.choiceChip,
                isActive && styles.choiceChipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.choiceLabel,
                  isActive && styles.choiceLabelActive,
                ]}
              >
                {fileDirty ? '• ' : ''}
                {FILE_LABELS[f]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.paneSubtitle}>{FILE_HINTS[active]}</Text>

      {pane.load_error !== null ? (
        <Text style={styles.bannerError} testID="admin-persona-load-error">
          {pane.load_error}
        </Text>
      ) : null}
      {!pane.exists && pane.load_error === null ? (
        <Text style={styles.bannerInfo} testID="admin-persona-empty-state">
          {`(no ${active} yet — start typing and Save to seed the file)`}
        </Text>
      ) : null}

      {/* Edit / Preview toggle (narrow viewports stack; wide shows both) */}
      {!wideViewport ? (
        <View style={styles.choiceRow}>
          <Pressable
            accessibilityRole="tab"
            testID="admin-persona-mode-edit"
            onPress={() => setPreviewMode('edit')}
            style={[
              styles.choiceChip,
              previewMode === 'edit' && styles.choiceChipActive,
            ]}
          >
            <Text
              style={[
                styles.choiceLabel,
                previewMode === 'edit' && styles.choiceLabelActive,
              ]}
            >
              Edit
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            testID="admin-persona-mode-preview"
            onPress={() => setPreviewMode('preview')}
            style={[
              styles.choiceChip,
              previewMode === 'preview' && styles.choiceChipActive,
            ]}
          >
            <Text
              style={[
                styles.choiceLabel,
                previewMode === 'preview' && styles.choiceLabelActive,
              ]}
            >
              Preview
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Editor + preview.
          Frontend race P1-2 / P1-3 fix: editable={!pane.saving} so
          keystrokes that arrive while a save / reload is in flight are
          swallowed instead of silently erased (or quietly racing the
          PATCH on the wire). */}
      {wideViewport ? (
        <View style={styles.editorRow}>
          <View style={styles.editorPaneWide}>
            <TextInput
              accessibilityLabel={`${active} editor`}
              testID={`admin-persona-editor-${active}`}
              multiline
              editable={!pane.saving}
              value={pane.draft}
              onChangeText={(t) => updatePane(active, { draft: t })}
              style={[styles.textarea, styles.editorFill]}
              placeholder={`# ${FILE_LABELS[active]}\n`}
              placeholderTextColor="#5a5a5a"
            />
          </View>
          <ScrollView
            style={styles.editorPaneWide}
            contentContainerStyle={styles.previewScroll}
          >
            <RenderMarkdown source={pane.draft.length === 0 ? '_empty_' : pane.draft} />
          </ScrollView>
        </View>
      ) : previewMode === 'edit' ? (
        <TextInput
          accessibilityLabel={`${active} editor`}
          testID={`admin-persona-editor-${active}`}
          multiline
          editable={!pane.saving}
          value={pane.draft}
          onChangeText={(t) => updatePane(active, { draft: t })}
          style={styles.textarea}
          placeholder={`# ${FILE_LABELS[active]}\n`}
          placeholderTextColor="#5a5a5a"
        />
      ) : (
        <ScrollView
          style={styles.previewMobile}
          contentContainerStyle={styles.previewScroll}
        >
          <RenderMarkdown source={pane.draft.length === 0 ? '_empty_' : pane.draft} />
        </ScrollView>
      )}

      {pane.conflict !== null ? (
        <View style={styles.conflictRow} testID="admin-persona-conflict">
          <Text style={styles.bannerError}>
            File changed elsewhere — your edits are still in the box. Reload to
            pull the latest, or Force overwrite to send yours anyway.
          </Text>
          <View style={styles.conflictBtnRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reload from disk"
              testID="admin-persona-conflict-reload"
              onPress={() => void reloadOne(active)}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>Reload</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Force overwrite"
              testID="admin-persona-conflict-force"
              onPress={() => void saveOne(active, { force: true })}
              style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
            >
              <Text style={styles.dangerBtnText}>Force overwrite</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {pane.error !== null && pane.conflict === null ? (
        <Text style={styles.bannerError}>{pane.error}</Text>
      ) : null}
      {pane.saved_at !== null && pane.error === null && pane.conflict === null ? (
        <Text style={styles.bannerOk} testID="admin-persona-saved">
          Saved.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Save ${active}`}
        testID={`admin-persona-save-${active}`}
        disabled={!dirty || pane.saving}
        onPress={() => void saveOne(active)}
        style={({ pressed }) => [
          styles.primaryBtn,
          (!dirty || pane.saving) && styles.primaryBtnDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.primaryBtnText}>
          {pane.saving ? 'Saving…' : dirty ? `Save ${FILE_LABELS[active]}` : 'No changes'}
        </Text>
      </Pressable>

      <View style={styles.divider} />

      {/* Restart from scratch.
          Architecture P1-A (Argus r1 2026-05-22): modal copy + result
          banner are honest about the M1 limitations — the runtime
          doesn't read persona files at agent-turn time today, and the
          onboarding-phase reset hook is unwired. Deletion is real;
          everything else lands once those follow-ups ship. */}
      <View style={styles.intro}>
        <Text style={styles.label}>Danger zone</Text>
        <Text style={styles.paneSubtitle}>
          Restart from scratch deletes the three persona files on disk.
          In M1 the runtime does not yet read these files at agent-turn
          time and the onboarding phase reset is not wired, so the next
          chat will behave the same. The Reload + Force-overwrite flow
          above is the day-to-day edit path; this button is here for
          when you want a clean slate to start over.
        </Text>
        {restartStatus !== null ? (
          <Text
            style={
              restartBannerKind(restartStatus) === 'error'
                ? styles.bannerError
                : styles.bannerOk
            }
            testID="admin-persona-restart-result"
          >
            {restartStatus.message}
          </Text>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restart personality from scratch"
        testID="admin-persona-restart"
        disabled={restarting}
        onPress={() => {
          // Frontend race P2-3: clear the stale prior-restart result
          // banner the moment the user re-opens the modal, so the next
          // session never sees stale "Deleted 3 files" text next to a
          // restart that hasn't happened yet.
          setRestartStatus(null);
          setRestartConfirm(true);
        }}
        style={({ pressed }) => [
          styles.dangerBtn,
          restarting && styles.primaryBtnDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.dangerBtnText}>
          {restarting ? 'Restarting…' : 'Restart from scratch'}
        </Text>
      </Pressable>

      <Modal
        transparent
        visible={restartConfirm}
        animationType="fade"
        onRequestClose={() => setRestartConfirm(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalPanel}>
            <Text style={styles.modalTitle}>Restart from scratch?</Text>
            <Text style={styles.modalBody}>
              Deletes your SOUL.md, USER.md, and priority-map.md from
              disk. There is no undo.{'\n\n'}
              In M1 the runtime does not yet read these files and the
              onboarding phase reset is not wired, so your next chat
              will behave the same until those follow-ups ship. Use
              this when you want a clean slate; use the Reload + Force-
              overwrite flow above for everyday edits.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel restart"
                testID="admin-persona-restart-cancel"
                onPress={() => setRestartConfirm(false)}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Confirm restart"
                testID="admin-persona-restart-confirm"
                onPress={() => void restartFromScratch()}
                style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
              >
                <Text style={styles.dangerBtnText}>Yes, delete the files</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 8 },
  paneTitle: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  code: { color: '#cfcfcf', fontFamily: 'Menlo', fontSize: 12 },
  label: {
    color: '#6a6a6a',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  textarea: {
    minHeight: 220,
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fafafa',
    fontSize: 13,
    lineHeight: 18,
    textAlignVertical: 'top',
  },
  editorRow: { flexDirection: 'row', gap: 8, minHeight: 320 },
  editorPaneWide: { flex: 1, minHeight: 320 },
  editorFill: { flex: 1, minHeight: 320 },
  previewMobile: {
    minHeight: 220,
    backgroundColor: '#0d0d0d',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  previewScroll: { padding: 12 },
  divider: {
    height: 1,
    backgroundColor: '#1a1a1a',
    marginVertical: 16,
  },
  conflictRow: { gap: 8 },
  conflictBtnRow: { flexDirection: 'row', gap: 8 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  choiceChipActive: { backgroundColor: '#1f2937', borderColor: '#374151' },
  choiceLabel: { color: '#9a9a9a', fontSize: 12, fontWeight: '500' },
  choiceLabelActive: { color: '#fafafa', fontWeight: '600' },
  primaryBtn: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignSelf: 'flex-start',
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#0a0a0a', fontSize: 14, fontWeight: '600' },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
  dangerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#7f1d1d',
    alignSelf: 'flex-start',
  },
  dangerBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  bannerError: {
    backgroundColor: '#3b1212',
    color: '#fecaca',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    fontSize: 12,
  },
  bannerOk: {
    backgroundColor: '#0f2418',
    color: '#bbf7d0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#14532d',
    fontSize: 12,
  },
  bannerInfo: {
    backgroundColor: '#0f1c2e',
    color: '#bfdbfe',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1e40af',
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalPanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#121212',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 18,
    gap: 12,
  },
  modalTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  modalBody: { color: '#bdbdbd', fontSize: 13, lineHeight: 18 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  pressed: { opacity: 0.7 },
});
