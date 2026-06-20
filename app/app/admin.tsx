/**
 * @neutronai/app — admin tab (P5.7).
 *
 * Per SPEC.md § Phases→Steps / P5.7 — Personality
 * edit, gateway reboot (Open-tier), GBrain browse, connector admin.
 *
 * Structured as one top-level screen with horizontal sub-tabs so the
 * user can cycle without bouncing through router state. Each sub-tab
 * is a pure component that fetches the relevant slice from the
 * `/api/app/admin/*` surface on mount.
 *
 * Current sub-tabs:
 *   - Personality / Gateway / GBrain / Cores / Backup (P5.7 + P7.4)
 *   - Max account (2026-06-01 switch-Max-account sprint) — lets an
 *     already-onboarded owner swap their attached Claude Max
 *     credential to a different Anthropic account without operator
 *     SQL. Calls `AdminClient.mintMaxReauthToken()` to get a fresh
 *     identity-side paste URL and opens it in the browser.
 *
 * Implementation notes:
 *   - Server is authoritative; every PUT/POST round-trips and the
 *     response replaces local state.
 *   - The Gateway tab confirms before signalling the restart (one
 *     mis-tap could otherwise drop the user's session).
 *   - GBrain + Connectors render an empty-state banner when the
 *     surface returns `configured: false` (Open self-hosters without
 *     a GBrain MCP wired, or a fresh instance before Cores
 *     install).
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { loadAppConfig } from '../lib/config';
import { useAuthSession } from '../lib/session';
import {
  AdminClient,
  AdminClientError,
  type GenerateKeypairResult,
  type MemorySummary,
  type ProjectBackupResult,
  type ProjectBackupStatus,
} from '../lib/admin-client';
import {
  AdminPersonalityClient,
  AdminPersonalityClientError,
  PERSONA_FILENAMES,
  type PersonaFilename,
} from '../lib/admin-personality-client';
import {
  buildSavePayload,
  makePerFileMutateGates,
  restartBannerKind,
  summarizeRestart,
  summarizeRestartFailure,
  type RestartStatus,
} from '../lib/personality-pane-helpers';
import {
  CoresClient,
  CoresClientError,
  type CoreSummary,
  type OAuthStatusResponse,
} from '../lib/cores-client';
import { RenderMarkdown } from '../lib/markdown-render';

type AdminPaneKey =
  | 'personality'
  | 'gateway'
  | 'memory'
  | 'cores'
  | 'backup'
  | 'maxAccount';

interface PaneSpec {
  key: AdminPaneKey;
  label: string;
}

const PANES: ReadonlyArray<PaneSpec> = [
  { key: 'personality', label: 'Personality' },
  { key: 'gateway', label: 'Gateway' },
  { key: 'memory', label: 'Memory' },
  { key: 'cores', label: 'Cores' },
  { key: 'backup', label: 'Backup' },
  { key: 'maxAccount', label: 'Max account' },
];

export default function AdminScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const client = useMemo(() => {
    if (user === null) return null;
    return new AdminClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);
  const coresClient = useMemo(() => {
    if (user === null) return null;
    return new CoresClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);
  const personaClient = useMemo(() => {
    if (user === null) return null;
    return new AdminPersonalityClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [active, setActive] = useState<AdminPaneKey>('personality');

  useEffect(() => {
    if (user === null) router.replace('/login');
  }, [router, user]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to projects"
          testID="admin-back"
          onPress={() => router.replace('/projects')}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Admin</Text>
          <Text style={styles.headerTitle}>Settings</Text>
        </View>
        <View style={styles.headerIconBtn} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBarContent}
        style={styles.tabBar}
      >
        {PANES.map((pane) => {
          const isActive = pane.key === active;
          return (
            <Pressable
              key={pane.key}
              accessibilityRole="tab"
              accessibilityLabel={`${pane.label} pane`}
              accessibilityState={{ selected: isActive }}
              testID={`admin-tab-${pane.key}`}
              onPress={() => setActive(pane.key)}
              style={({ pressed }) => [
                styles.tabItem,
                isActive && styles.tabItemActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{pane.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.paneContent}>
        {client === null ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#cfcfcf" />
          </View>
        ) : active === 'personality' ? (
          personaClient !== null ? (
            <PersonalityPane client={personaClient} />
          ) : (
            <View style={styles.centered}>
              <ActivityIndicator color="#cfcfcf" />
            </View>
          )
        ) : active === 'gateway' ? (
          <GatewayPane client={client} />
        ) : active === 'memory' ? (
          <MemoryPane client={client} />
        ) : active === 'backup' ? (
          <BackupPane client={client} />
        ) : active === 'maxAccount' ? (
          <MaxAccountPane client={client} />
        ) : coresClient !== null ? (
          <CoresPane client={coresClient} router={router} />
        ) : (
          <View style={styles.centered}>
            <ActivityIndicator color="#cfcfcf" />
          </View>
        )}
      </View>
    </View>
  );
}

// ─── PersonalityPane (2026-05-22) ────────────────────────────────────
//
// Three-file markdown editor for `<owner_home>/persona/SOUL.md`,
// `USER.md`, `priority-map.md`. Replaces the prior single-textarea
// shape (PR #155) per
// docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
//
// Layout:
//   - Top: file-selector chips (SOUL / USER / priority-map). Each chip
//     shows a •dot when its file has unsaved edits so the user knows
//     which panes still need saving.
//   - Middle: edit/preview toggle. On wide viewports (>= 720 px) the
//     editor + preview render side-by-side; on narrow viewports they
//     stack with a Editor/Preview toggle.
//   - Per-pane Save button. Disabled when not dirty.
//   - 409 conflict banner with a Reload button (loses the in-progress
//     draft to fetch the canonical body) AND a Force overwrite button
//     (sends `expected_mtime: -1`).
//   - Bottom: Restart-from-scratch danger button + confirm modal.
//
// Hot-reload: every successful save fires the gateway's `onReload`
// hook (no-op in M1 — see surface header). The next chat turn re-reads
// from disk regardless because the system-prompt assembler has no
// cache (runtime/system-prompt.ts:71-80).

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

function PersonalityPane({ client }: { client: AdminPersonalityClient }) {
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

function formatPersonaError(err: unknown): string {
  if (err instanceof AdminPersonalityClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function GatewayPane({ client }: { client: AdminClient }) {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setRestarting(true);
    setError(null);
    setResult(null);
    try {
      const r = await client.restartGateway();
      setResult(
        r.triggered
          ? `Restart signalled at ${new Date(r.triggered_at).toLocaleTimeString()} (tier=${r.tier}).`
          : `Restart not triggered (tier=${r.tier}).`,
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setRestarting(false);
      setConfirming(false);
    }
  }, [client]);

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Gateway</Text>
        <Text style={styles.paneSubtitle}>
          Restart this instance's gateway process. This signals SIGTERM so
          systemd brings the unit back.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}
      {result !== null ? <Text style={styles.bannerOk}>{result}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restart gateway"
        testID="admin-gateway-restart"
        disabled={restarting}
        onPress={() => setConfirming(true)}
        style={({ pressed }) => [
          styles.dangerBtn,
          restarting && styles.primaryBtnDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.dangerBtnText}>
          {restarting ? 'Signalling restart…' : 'Restart gateway'}
        </Text>
      </Pressable>

      <Modal transparent visible={confirming} animationType="fade" onRequestClose={() => setConfirming(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalPanel}>
            <Text style={styles.modalTitle}>Restart gateway?</Text>
            <Text style={styles.modalBody}>
              This drops any open chat sessions for ~3–10 seconds while the
              process restarts.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel restart"
                testID="admin-gateway-cancel"
                onPress={() => setConfirming(false)}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Confirm restart"
                testID="admin-gateway-confirm"
                onPress={() => void handleConfirm()}
                style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
              >
                <Text style={styles.dangerBtnText}>Yes, restart</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function MemoryPane({ client }: { client: AdminClient }) {
  const [data, setData] = useState<MemorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOne = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await client.getMemory();
      setData(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchOne();
  }, [fetchOne]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Memory</Text>
        <Text style={styles.paneSubtitle}>
          Read-only browse of this instance's memory store. Editing entries lands
          in a follow-up sprint.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

      {data !== null && data.configured === false ? (
        <Text style={styles.bannerInfo}>
          Memory is not configured for this instance. The MCP transport is
          unwired; entries will appear here once it's mounted.
        </Text>
      ) : null}

      {data !== null && data.stats !== null ? (
        <View style={styles.statsCard}>
          <View style={styles.statsRow}>
            <Text style={styles.statsLabel}>Entries</Text>
            <Text style={styles.statsValue}>{data.stats.count}</Text>
          </View>
          <View style={styles.statsRow}>
            <Text style={styles.statsLabel}>Size</Text>
            <Text style={styles.statsValue}>{formatBytes(data.stats.size_bytes)}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.label}>Recent entries</Text>
      {data !== null && data.entries.length === 0 ? (
        <Text style={styles.muted}>No entries.</Text>
      ) : (
        (data?.entries ?? []).map((e) => (
          <View key={e.id} style={styles.entryCard} testID={`admin-memory-entry-${e.id}`}>
            <Text style={styles.entryPreview}>{e.content_preview}</Text>
            <Text style={styles.entryMeta}>
              score {e.score.toFixed(2)} · {e.id}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function CoresPane({
  client,
  router,
}: {
  client: CoresClient;
  router: ReturnType<typeof useRouter>;
}) {
  const [cores, setCores] = useState<CoreSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.list();
      setCores(list);
    } catch (err) {
      setError(formatCoresError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const handleInstall = useCallback(
    async (slug: string) => {
      setPendingSlug(slug);
      try {
        await client.install(slug);
        await fetchAll();
      } catch (err) {
        setError(formatCoresError(err));
      } finally {
        setPendingSlug(null);
      }
    },
    [client, fetchAll],
  );

  const handleUninstall = useCallback(
    async (slug: string) => {
      setPendingSlug(slug);
      try {
        await client.uninstall(slug);
        await fetchAll();
      } catch (err) {
        setError(formatCoresError(err));
      } finally {
        setPendingSlug(null);
      }
    },
    [client, fetchAll],
  );

  const handleOpenCore = useCallback(
    (slug: string) => {
      router.push(`/cores/${slug}`);
    },
    [router],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Cores</Text>
        <Text style={styles.paneSubtitle}>
          Bundled Tier 1 Cores. Tap a Core to open its setup screen — connect
          OAuth, view tools, install / uninstall.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

      {cores !== null && cores.length === 0 ? (
        <Text style={styles.muted}>No Cores discovered.</Text>
      ) : null}

      {(cores ?? []).map((c) => (
        <CoreRow
          key={c.slug}
          core={c}
          busy={pendingSlug === c.slug}
          onInstall={() => void handleInstall(c.slug)}
          onUninstall={() => void handleUninstall(c.slug)}
          onOpen={() => handleOpenCore(c.slug)}
        />
      ))}
    </ScrollView>
  );
}

function CoreRow({
  core,
  busy,
  onInstall,
  onUninstall,
  onOpen,
}: {
  core: CoreSummary;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onOpen: () => void;
}) {
  const isInstalled = core.install_state === 'installed';
  const isFailed =
    core.install_state === 'failed' ||
    core.install_state === 'install_failed_runtime' ||
    core.install_state === 'install_failed_dependency_missing';
  const needsOAuth =
    isFailed && core.required_oauth_labels.length > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${core.display_name} Core`}
      testID={`admin-core-${core.slug}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.coreCard, pressed && styles.pressed]}
    >
      <View style={styles.coreHeaderRow}>
        <Text style={styles.coreTitle}>{core.display_name}</Text>
        <CoreStateBadge state={core.install_state} />
      </View>
      {core.description.length > 0 ? (
        <Text style={styles.coreDescription}>{core.description}</Text>
      ) : null}
      {core.install_error !== undefined ? (
        <Text style={styles.coreError}>
          {core.install_error.code}: {core.install_error.message}
        </Text>
      ) : null}
      <View style={styles.coreActionsRow}>
        {needsOAuth ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connect ${core.display_name}`}
            testID={`admin-core-${core.slug}-connect`}
            onPress={onOpen}
            style={({ pressed }) => [
              styles.primaryActionBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryActionBtnText}>Connect</Text>
          </Pressable>
        ) : isInstalled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Uninstall ${core.display_name}`}
            testID={`admin-core-${core.slug}-uninstall`}
            disabled={busy}
            onPress={onUninstall}
            style={({ pressed }) => [
              styles.secondaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryActionBtnText}>
              {busy ? 'Uninstalling…' : 'Uninstall'}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Install ${core.display_name}`}
            testID={`admin-core-${core.slug}-install`}
            disabled={busy}
            onPress={onInstall}
            style={({ pressed }) => [
              styles.primaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryActionBtnText}>
              {busy ? 'Installing…' : 'Install'}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${core.display_name}`}
          testID={`admin-core-${core.slug}-open`}
          onPress={onOpen}
          style={({ pressed }) => [styles.tertiaryActionBtn, pressed && styles.pressed]}
        >
          <Text style={styles.tertiaryActionBtnText}>Open</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function CoreStateBadge({ state }: { state: CoreSummary['install_state'] }) {
  const label = stateLabel(state);
  const style =
    state === 'installed'
      ? styles.coreBadgeOk
      : state === 'not_installed'
        ? styles.coreBadgeNeutral
        : styles.coreBadgeWarn;
  return <Text style={[styles.coreBadge, style]}>{label}</Text>;
}

function stateLabel(state: CoreSummary['install_state']): string {
  switch (state) {
    case 'installed':
      return 'Installed';
    case 'not_installed':
      return 'Not installed';
    case 'failed':
      return 'Setup required';
    case 'install_failed_runtime':
      return 'Reconnect';
    case 'install_failed_dependency_missing':
      return 'Disconnected';
    default:
      return state;
  }
}

function formatCoresError(err: unknown): string {
  if (err instanceof CoresClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatError(err: unknown): string {
  if (err instanceof AdminClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(ts_ms: number, now: number): string {
  const delta = Math.max(0, now - ts_ms);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function formatIso(iso: string | null, now: number): string {
  if (iso === null) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return formatRelative(ts, now);
}

function formatNext(iso: string | null, now: number): string {
  if (iso === null) return 'not scheduled';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, ts - now);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'in <1m';
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  if (hr < 24) return `in ${hr}h ${remMin}m`;
  const days = Math.floor(hr / 24);
  return `in ${days}d`;
}

interface BackupCardEntry {
  project_id: string;
  status: ProjectBackupStatus | null;
  loadError: string | null;
}

function BackupPane({ client }: { client: AdminClient }): React.ReactElement {
  const [entries, setEntries] = useState<BackupCardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [modalProject, setModalProject] = useState<string | null>(null);
  const [busyProject, setBusyProject] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.listBackupProjects();
      setConfigured(list.configured);
      const fetched: BackupCardEntry[] = await Promise.all(
        list.projects.map(async (entry) => {
          try {
            const status = await client.getProjectBackupStatus(entry.project_id);
            return { project_id: entry.project_id, status, loadError: null };
          } catch (err) {
            return {
              project_id: entry.project_id,
              status: null,
              loadError: formatError(err),
            };
          }
        }),
      );
      setEntries(fetched);
      setNow(Date.now());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const runNow = useCallback(
    async (project_id: string) => {
      setBusyProject(project_id);
      try {
        await client.runProjectBackupNow(project_id);
        await fetchAll();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusyProject(null);
      }
    },
    [client, fetchAll],
  );

  const disconnect = useCallback(
    async (project_id: string) => {
      setBusyProject(project_id);
      try {
        await client.disconnectProjectBackupRemote(project_id);
        await fetchAll();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusyProject(null);
      }
    },
    [client, fetchAll],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  if (!configured) {
    return (
      <ScrollView contentContainerStyle={styles.paneScroll}>
        <View style={styles.intro}>
          <Text style={styles.paneTitle}>Backup</Text>
          <Text style={styles.paneSubtitle}>
            Project-level backup is not configured on this gateway.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Backup</Text>
        <Text style={styles.paneSubtitle}>
          Each project is snapshotted every 6 hours into a hidden{' '}
          <Text style={styles.code}>.project-backup/</Text> repo. Open self-hosters
          can also wire a remote (GitHub deploy key) for off-machine disaster
          recovery.
        </Text>
      </View>

      {error !== null ? (
        <Text style={styles.bannerError} testID="admin-backup-error">
          {error}
        </Text>
      ) : null}

      {entries.length === 0 ? (
        <Text style={styles.muted} testID="admin-backup-empty">
          No projects yet — create one to start backing up.
        </Text>
      ) : null}

      {entries.map((entry) => (
        <BackupCard
          key={entry.project_id}
          entry={entry}
          now={now}
          busy={busyProject === entry.project_id}
          onRunNow={() => void runNow(entry.project_id)}
          onConnect={() => setModalProject(entry.project_id)}
          onDisconnect={() => void disconnect(entry.project_id)}
        />
      ))}

      <ConnectRemoteModal
        client={client}
        project_id={modalProject}
        onClose={() => setModalProject(null)}
        onSuccess={() => {
          setModalProject(null);
          void fetchAll();
        }}
      />
    </ScrollView>
  );
}

function BackupCard(props: {
  entry: BackupCardEntry;
  now: number;
  busy: boolean;
  onRunNow: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}): React.ReactElement {
  const { entry, now, busy, onRunNow, onConnect, onDisconnect } = props;
  const status = entry.status;
  return (
    <View style={styles.connectorCard} testID={`admin-backup-card-${entry.project_id}`}>
      <View style={styles.connectorHeader}>
        <Text style={styles.connectorTitle}>{entry.project_id}</Text>
        {status !== null ? <BackupStateBadge state={status.state} /> : null}
      </View>
      {entry.loadError !== null ? (
        <Text style={styles.coreError}>{entry.loadError}</Text>
      ) : null}
      {status !== null ? (
        <>
          <Text style={styles.connectorMeta}>
            Last backup: {formatIso(status.last_backup_at, now)}
            {status.last_commit_sha !== null
              ? ` • commit ${status.last_commit_sha.slice(0, 7)}`
              : ''}
          </Text>
          {status.remote_url !== null ? (
            <Text style={styles.connectorMeta}>
              Remote: {status.remote_url}
              {status.is_managed_remote ? ' (auto-provisioned)' : ''}
            </Text>
          ) : (
            <Text style={styles.connectorMeta}>
              Local-only — versions stored on this machine.
            </Text>
          )}
          <Text style={styles.connectorMeta}>
            Next backup: {formatNext(status.next_scheduled_at, now)}
          </Text>
          {status.last_push_error !== null ? (
            <Text style={styles.coreError}>
              Push error ({status.last_push_error.code}): {status.last_push_error.message}
            </Text>
          ) : null}
        </>
      ) : null}
      <View style={styles.coreActionsRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Run backup now for ${entry.project_id}`}
          testID={`admin-backup-${entry.project_id}-run`}
          disabled={busy}
          onPress={onRunNow}
          style={({ pressed }) => [
            styles.primaryActionBtn,
            busy && styles.actionBtnDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.primaryActionBtnText}>
            {busy ? 'Running…' : 'Run backup now'}
          </Text>
        </Pressable>
        {status !== null && status.remote_url === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connect remote for ${entry.project_id}`}
            testID={`admin-backup-${entry.project_id}-connect`}
            disabled={busy}
            onPress={onConnect}
            style={({ pressed }) => [
              styles.secondaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryActionBtnText}>Connect remote</Text>
          </Pressable>
        ) : null}
        {status !== null && status.remote_url !== null && !status.is_managed_remote ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Disconnect remote for ${entry.project_id}`}
            testID={`admin-backup-${entry.project_id}-disconnect`}
            disabled={busy}
            onPress={onDisconnect}
            style={({ pressed }) => [
              styles.tertiaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.tertiaryActionBtnText}>Disconnect</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function BackupStateBadge({
  state,
}: {
  state: ProjectBackupStatus['state'];
}): React.ReactElement {
  const label = backupStateLabel(state);
  const cls =
    state === 'ok'
      ? styles.coreBadgeOk
      : state === 'error'
        ? styles.coreBadgeWarn
        : state === 'backing_up'
          ? styles.coreBadgeNeutral
          : styles.coreBadgeNeutral;
  return <Text style={[styles.coreBadge, cls]}>{label}</Text>;
}

function backupStateLabel(state: ProjectBackupStatus['state']): string {
  switch (state) {
    case 'not_configured':
      return 'Unavailable';
    case 'configured':
      return 'Ready';
    case 'backing_up':
      return 'Backing up';
    case 'ok':
      return 'OK';
    case 'error':
      return 'Error';
    default:
      return state;
  }
}

function ConnectRemoteModal(props: {
  client: AdminClient;
  project_id: string | null;
  onClose: () => void;
  onSuccess: (result: ProjectBackupResult) => void;
}): React.ReactElement | null {
  const { client, project_id, onClose, onSuccess } = props;
  const [remoteUrl, setRemoteUrl] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [keypair, setKeypair] = useState<GenerateKeypairResult | null>(null);
  const [mode, setMode] = useState<'existing' | 'generate'>('existing');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state on project change.
  useEffect(() => {
    setRemoteUrl('');
    setKeyPem('');
    setKeypair(null);
    setMode('existing');
    setError(null);
    setSubmitting(false);
  }, [project_id]);

  if (project_id === null) return null;

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const input: { remote_url: string; ssh_key_pem?: string; generated_key_request_id?: string } = {
        remote_url: remoteUrl.trim(),
      };
      if (mode === 'existing') {
        input.ssh_key_pem = keyPem;
      } else if (keypair !== null) {
        input.generated_key_request_id = keypair.request_id;
      } else {
        setError('Generate a keypair first.');
        setSubmitting(false);
        return;
      }
      const result = await client.configureProjectBackup(project_id, input);
      onSuccess(result.backup);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerate = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.generateProjectBackupKeypair(project_id);
      setKeypair(result);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={project_id !== null} transparent animationType="fade">
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel}>
          <Text style={styles.modalTitle}>Connect remote for {project_id}</Text>
          <View style={styles.choiceRow}>
            <Pressable
              accessibilityRole="button"
              testID="admin-backup-modal-mode-existing"
              onPress={() => setMode('existing')}
              style={[
                styles.choiceChip,
                mode === 'existing' && styles.choiceChipActive,
              ]}
            >
              <Text
                style={[
                  styles.choiceLabel,
                  mode === 'existing' && styles.choiceLabelActive,
                ]}
              >
                Use existing key
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="admin-backup-modal-mode-generate"
              onPress={() => setMode('generate')}
              style={[
                styles.choiceChip,
                mode === 'generate' && styles.choiceChipActive,
              ]}
            >
              <Text
                style={[
                  styles.choiceLabel,
                  mode === 'generate' && styles.choiceLabelActive,
                ]}
              >
                Generate new keypair
              </Text>
            </Pressable>
          </View>
          <Text style={styles.label}>Remote URL (git@host:owner/repo.git)</Text>
          <TextInput
            value={remoteUrl}
            onChangeText={setRemoteUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="git@github.com:example/project-backup.git"
            placeholderTextColor="#5a5a5a"
            style={styles.textarea}
            testID="admin-backup-modal-remote-url"
          />
          {mode === 'existing' ? (
            <>
              <Text style={styles.label}>SSH private key (PEM)</Text>
              <TextInput
                value={keyPem}
                onChangeText={setKeyPem}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                placeholderTextColor="#5a5a5a"
                style={[styles.textarea, { minHeight: 100 }]}
                testID="admin-backup-modal-key-pem"
              />
            </>
          ) : (
            <>
              {keypair === null ? (
                <Pressable
                  accessibilityRole="button"
                  testID="admin-backup-modal-generate"
                  disabled={submitting}
                  onPress={() => void handleGenerate()}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    submitting && styles.actionBtnDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryBtnText}>
                    {submitting ? 'Generating…' : 'Generate keypair'}
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Text style={styles.label}>Public key (register on remote)</Text>
                  <Text style={styles.code} selectable>
                    {keypair.public_key}
                  </Text>
                </>
              )}
            </>
          )}
          {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              testID="admin-backup-modal-cancel"
              onPress={onClose}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="admin-backup-modal-submit"
              disabled={submitting || remoteUrl.trim().length === 0}
              onPress={() => void handleSubmit()}
              style={({ pressed }) => [
                styles.primaryBtn,
                (submitting || remoteUrl.trim().length === 0) && styles.primaryBtnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>{submitting ? 'Connecting…' : 'Connect'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── MaxAccountPane (2026-06-01 switch-Max-account sprint) ──────────
//
// Lets an already-onboarded owner swap their attached Claude Max
// credential to a different Anthropic account without operator SQL.
//
// Flow:
//   1. User taps "Switch account".
//   2. We POST `/api/app/admin/max-oauth/mint-reauth-token` and the
//      gateway mints a fresh start_token JWT bound to this instance +
//      authenticated user, returning a full paste URL pointing at
//      `<identity>/oauth/max/start` (with instance + return + start_token + force params).
//   3. We hand the URL to `Linking.openURL` which opens the user's
//      browser. The identity-side paste-token form is already in
//      production (see `identity/oauth/max-handoff.ts:handleStart`)
//      and accepts any valid start_token regardless of how it was
//      minted. The user runs `claude setup-token`, pastes the new
//      value, and the existing `persistPasteToken` flow replaces the
//      stored Max credential atomically (`auth/max-oauth.ts ~line 340`).
//
// Deployments without the identity-DB wiring (Open self-host without
// NEUTRON_AUTH_DB_PATH) get a 503 `reauth_not_configured` envelope;
// we render the "not supported here" branch instead of the button so
// the user isn't stuck pressing a broken control.
//
// Disconnect / cancel subscription is out of scope for this sprint —
// the button is a "Coming soon" disabled affordance so the visual
// shape is correct when the follow-up lands.

interface MaxAccountState {
  switching: boolean;
  error: string | null;
  notSupported: { message: string } | null;
}

function freshMaxAccountState(): MaxAccountState {
  return { switching: false, error: null, notSupported: null };
}

function MaxAccountPane({ client }: { client: AdminClient }): React.ReactElement {
  const [state, setState] = useState<MaxAccountState>(() => freshMaxAccountState());

  const handleSwitch = useCallback(async () => {
    setState({ switching: true, error: null, notSupported: null });
    try {
      const result = await client.mintMaxReauthToken();
      // Open the paste URL externally. On web `Linking.openURL` opens
      // a new tab; on native it hands off to the system browser.
      await Linking.openURL(result.paste_url);
      setState(freshMaxAccountState());
    } catch (err) {
      if (
        err instanceof AdminClientError &&
        err.code === 'reauth_not_configured'
      ) {
        setState({
          switching: false,
          error: null,
          notSupported: { message: err.message },
        });
        return;
      }
      setState({
        switching: false,
        error: formatError(err),
        notSupported: null,
      });
    }
  }, [client]);

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Claude Max account</Text>
        <Text style={styles.paneSubtitle}>
          This instance uses your personal Claude Max subscription to power
          chat. Switching accounts swaps the stored credential atomically —
          in-flight sessions keep their current token until the next chat
          turn picks up the new one.
        </Text>
      </View>

      {state.error !== null ? (
        <Text style={styles.bannerError} testID="admin-max-error">
          {state.error}
        </Text>
      ) : null}

      {state.notSupported !== null ? (
        <View style={styles.managedCard} testID="admin-max-not-supported">
          <View style={styles.managedBadgeRow}>
            <Text style={styles.managedBadge}>Not supported here</Text>
          </View>
          <Text style={styles.managedBody}>
            This deployment can't mint a fresh paste link from the app —
            the identity service isn't co-located with the gateway. Ask
            your operator to re-run the Max paste flow from the Anthropic
            sign-in page.
          </Text>
          <Text style={styles.managedHint}>{state.notSupported.message}</Text>
        </View>
      ) : (
        <View style={styles.coreActionsRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch Claude Max account"
            testID="admin-max-switch"
            disabled={state.switching}
            onPress={() => void handleSwitch()}
            style={({ pressed }) => [
              styles.primaryBtn,
              state.switching && styles.primaryBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {state.switching ? 'Opening paste form…' : 'Switch account'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Disconnect Claude Max account (coming soon)"
            testID="admin-max-disconnect"
            disabled
            style={({ pressed }) => [
              styles.secondaryBtn,
              styles.primaryBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryBtnText}>Disconnect (coming soon)</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.intro}>
        <Text style={styles.paneSubtitle}>
          Tapping <Text style={styles.code}>Switch account</Text> opens the
          Anthropic Max paste form in your browser. Run{' '}
          <Text style={styles.code}>claude setup-token</Text> in your
          terminal, copy the value, paste it, and submit. You'll be
          returned to chat once the new credential is stored.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  headerIcon: { color: '#e0e0e0', fontSize: 18, fontWeight: '600' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  headerOverline: {
    color: '#7a7a7a',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 1 },
  pressed: { opacity: 0.7 },
  tabBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  tabBarContent: { paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  tabItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'transparent',
  },
  tabItemActive: { backgroundColor: '#1a1a1a' },
  tabLabel: { color: '#888', fontSize: 13, fontWeight: '500' },
  tabLabelActive: { color: '#fafafa', fontWeight: '600' },
  paneContent: { flex: 1 },
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
  managedCard: {
    backgroundColor: '#0f1c2e',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e40af',
    padding: 14,
    gap: 10,
  },
  managedBadgeRow: { flexDirection: 'row' },
  managedBadge: {
    color: '#bfdbfe',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    backgroundColor: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  managedBody: { color: '#dbeafe', fontSize: 13, lineHeight: 18 },
  managedHint: { color: '#8aa8d6', fontSize: 11, fontStyle: 'italic' },
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
  statsCard: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 6,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statsLabel: { color: '#7a7a7a', fontSize: 12 },
  statsValue: { color: '#fafafa', fontSize: 13, fontWeight: '600' },
  entryCard: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 4,
  },
  entryPreview: { color: '#e0e0e0', fontSize: 13, lineHeight: 18 },
  entryMeta: { color: '#6a6a6a', fontSize: 11 },
  muted: { color: '#7a7a7a', fontSize: 13 },
  connectorCard: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 4,
  },
  connectorHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  connectorTitle: { color: '#fafafa', fontSize: 15, fontWeight: '600' },
  connectorVersion: { color: '#7a7a7a', fontSize: 11 },
  connectorMeta: { color: '#9a9a9a', fontSize: 12 },
  connectorCaps: { color: '#bfdbfe', fontSize: 11, marginTop: 4 },
  coreCard: {
    backgroundColor: '#121212',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 14,
    gap: 8,
  },
  coreHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  coreTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  coreDescription: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  coreError: { color: '#fecaca', fontSize: 11, fontFamily: 'Menlo' },
  coreActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  primaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  primaryActionBtnText: { color: '#0a0a0a', fontSize: 13, fontWeight: '600' },
  secondaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryActionBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
  tertiaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  tertiaryActionBtnText: { color: '#9a9a9a', fontSize: 13, fontWeight: '500' },
  actionBtnDisabled: { opacity: 0.5 },
  coreBadge: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  coreBadgeOk: { color: '#bbf7d0', backgroundColor: '#0f2418' },
  coreBadgeNeutral: { color: '#bdbdbd', backgroundColor: '#1f1f1f' },
  coreBadgeWarn: { color: '#fed7aa', backgroundColor: '#3b1d12' },
});
