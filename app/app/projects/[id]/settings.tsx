/**
 * @neutronai/app — project-scoped SETTINGS tab.
 *
 * The Settings lens the engine tab registry mounts as a `builtin` descriptor
 * (`mount.target: 'settings'`). Three stacked sections, each reading only from
 * `theme.ts` tokens:
 *
 *   1. Credentials — the project's own stored credentials plus the `global`
 *      defaults it inherits (rendered read-through, labeled "global default").
 *      An add form POSTs a new credential then refetches; a per-row delete
 *      control removes then refetches. Token VALUES are never displayed —
 *      the wire records are metadata-only (see `project-credentials-client.ts`).
 *   2. Project — the editable project name (rename via the settings PATCH
 *      `{ name }`) plus the editable rail emoji (PATCH `{ emoji }` through the
 *      same surface).
 *   3. Collaborators — DISPLAY-ONLY and M2-gated: the owner plus a visibly
 *      disabled Invite / Remove affordance. No write calls.
 *
 * Structure mirrors `workboard.tsx`: a thin route reading `project_id`, an auth
 * guard, then the body. All sizing flows from `theme.ts` tokens.
 */

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { loadAppConfig } from '../../../lib/config';
import {
  ProjectCredentialsClient,
  type CredentialScope,
  type ProjectCredentialRecord,
  type ProjectCredentialsList,
} from '../../../lib/project-credentials-client';
import { ProjectsClient, type ProjectMember } from '../../../lib/projects-client';
import { useAuthSession } from '../../../lib/session';
import { SPACING, THEME, TYPOGRAPHY } from '../../../lib/theme';

export default function SettingsTab() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View style={[styles.container, styles.centered]} testID="settings-bootstrapping">
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return <SettingsBody projectId={project_id} token={user.token} />;
}

function SettingsBody({ projectId, token }: { projectId: string; token: string }) {
  const config = useMemo(() => loadAppConfig(), []);
  const credClient = useMemo(
    () => new ProjectCredentialsClient({ base_url: config.base_url, token }),
    [config.base_url, token],
  );
  const projectsClient = useMemo(
    () => new ProjectsClient({ base_url: config.base_url, token }),
    [config.base_url, token],
  );

  // ── Credentials ────────────────────────────────────────────────────────────
  const [creds, setCreds] = useState<ProjectCredentialsList>({ project: [], global: [] });
  const [credsLoading, setCredsLoading] = useState(true);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [addService, setAddService] = useState('');
  const [addToken, setAddToken] = useState('');
  const [addScope, setAddScope] = useState<CredentialScope>('project');
  const [addLabel, setAddLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [credActionError, setCredActionError] = useState<string | null>(null);
  const [busyCred, setBusyCred] = useState<string | null>(null);

  // Monotonic guard so a slow list can't land after a fresher refetch.
  const credSeq = useRef(0);

  const refreshCreds = useCallback((): void => {
    const mine = (credSeq.current += 1);
    setCredsLoading(true);
    setCredsError(null);
    credClient
      .list(projectId)
      .then((list) => {
        if (mine !== credSeq.current) return;
        setCreds(list);
        setCredsLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== credSeq.current) return;
        setCreds({ project: [], global: [] });
        setCredsLoading(false);
        setCredsError(err instanceof Error ? err.message : 'failed to load credentials');
      });
  }, [credClient, projectId]);

  const addCredential = useCallback((): void => {
    const service = addService.trim();
    const secret = addToken.trim();
    if (service.length === 0 || secret.length === 0 || adding) return;
    const label = addLabel.trim();
    setAdding(true);
    setCredActionError(null);
    credClient
      .set(projectId, {
        service,
        token: secret,
        scope: addScope,
        ...(label.length > 0 ? { label } : {}),
      })
      .then(() => {
        setAdding(false);
        setAddService('');
        setAddToken('');
        setAddLabel('');
        refreshCreds();
      })
      .catch((err: unknown) => {
        setAdding(false);
        setCredActionError(err instanceof Error ? err.message : 'failed to save credential');
      });
  }, [credClient, projectId, addService, addToken, addScope, addLabel, adding, refreshCreds]);

  const deleteCredential = useCallback(
    (service: string, scope: CredentialScope): void => {
      const busyKey = `${scope}:${service}`;
      setBusyCred(busyKey);
      setCredActionError(null);
      credClient
        .remove(projectId, service, scope)
        .then(() => {
          setBusyCred(null);
          refreshCreds();
        })
        .catch((err: unknown) => {
          setBusyCred(null);
          setCredActionError(err instanceof Error ? err.message : 'failed to delete credential');
        });
    },
    [credClient, projectId, refreshCreds],
  );

  // ── Project + Collaborators ─────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [emoji, setEmoji] = useState('');
  const [emojiDraft, setEmojiDraft] = useState('');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [savingEmoji, setSavingEmoji] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [emojiError, setEmojiError] = useState<string | null>(null);

  const refreshProject = useCallback((): void => {
    setProjectLoading(true);
    projectsClient
      .getSettings(projectId)
      .then((settings) => {
        setName(settings.name);
        setNameDraft(settings.name);
        setEmoji(settings.emoji);
        setEmojiDraft(settings.emoji);
        setMembers(settings.members);
        setProjectLoading(false);
      })
      .catch((err: unknown) => {
        setProjectLoading(false);
        setProjectError(err instanceof Error ? err.message : 'failed to load project');
      });
  }, [projectsClient, projectId]);

  const renameProject = useCallback((): void => {
    const next = nameDraft.trim();
    if (next.length === 0 || next === name || renaming) return;
    setRenaming(true);
    setProjectError(null);
    projectsClient
      .rename(projectId, next)
      .then((settings) => {
        setName(settings.name);
        setNameDraft(settings.name);
        setRenaming(false);
      })
      .catch((err: unknown) => {
        setRenaming(false);
        setProjectError(err instanceof Error ? err.message : 'failed to rename project');
      });
  }, [projectsClient, projectId, nameDraft, name, renaming]);

  const saveEmoji = useCallback((): void => {
    const next = emojiDraft.trim();
    if (next.length === 0 || next === emoji || savingEmoji) return;
    setSavingEmoji(true);
    setEmojiError(null);
    projectsClient
      .setEmoji(projectId, next)
      .then((settings) => {
        setEmoji(settings.emoji);
        setEmojiDraft(settings.emoji);
        setSavingEmoji(false);
      })
      .catch((err: unknown) => {
        setSavingEmoji(false);
        setEmojiError(err instanceof Error ? err.message : 'failed to save emoji');
      });
  }, [projectsClient, projectId, emojiDraft, emoji, savingEmoji]);

  useEffect(() => {
    refreshCreds();
    refreshProject();
  }, [refreshCreds, refreshProject]);

  const owner = members.find((m) => m.role === 'owner') ?? null;
  const nameDirty = nameDraft.trim().length > 0 && nameDraft.trim() !== name;
  const emojiDirty = emojiDraft.trim().length > 0 && emojiDraft.trim() !== emoji;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="settings-scroll"
    >
      {/* ── Credentials ───────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Credentials</Text>
      <Text style={styles.sectionHint}>
        Tokens Neutron uses on this project. Values are write-only — they’re never shown back.
      </Text>

      {credsLoading ? (
        <View style={styles.sectionLoading} testID="settings-creds-loading">
          <ActivityIndicator color={THEME.text_secondary} />
        </View>
      ) : credsError !== null ? (
        <Text style={styles.error} testID="settings-creds-error">
          {credsError}
        </Text>
      ) : creds.project.length === 0 && creds.global.length === 0 ? (
        <Text style={styles.empty} testID="settings-creds-empty">
          No credentials yet. Add one below.
        </Text>
      ) : (
        <View testID="settings-creds-list">
          {creds.project.map((rec) => (
            <CredentialRow
              key={`project:${rec.service}`}
              rec={rec}
              inherited={false}
              busy={busyCred === `project:${rec.service}`}
              onDelete={() => deleteCredential(rec.service, 'project')}
            />
          ))}
          {creds.global.map((rec) => (
            <CredentialRow
              key={`global:${rec.service}`}
              rec={rec}
              inherited={true}
              busy={busyCred === `global:${rec.service}`}
              onDelete={() => deleteCredential(rec.service, 'global')}
            />
          ))}
        </View>
      )}

      {credActionError !== null ? (
        <Text style={styles.error} testID="settings-creds-action-error">
          {credActionError}
        </Text>
      ) : null}

      {/* Add form */}
      <View style={styles.addForm}>
        <TextInput
          style={styles.input}
          placeholder="Service (e.g. openai)"
          placeholderTextColor={THEME.text_muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={addService}
          onChangeText={setAddService}
          accessibilityLabel="Credential service"
          testID="settings-cred-service"
        />
        <TextInput
          style={styles.input}
          placeholder="Token"
          placeholderTextColor={THEME.text_muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          value={addToken}
          onChangeText={setAddToken}
          accessibilityLabel="Credential token"
          testID="settings-cred-token"
        />
        <TextInput
          style={styles.input}
          placeholder="Label (optional)"
          placeholderTextColor={THEME.text_muted}
          value={addLabel}
          onChangeText={setAddLabel}
          accessibilityLabel="Credential label"
          testID="settings-cred-label"
        />
        <View style={styles.scopeRow}>
          <ScopeToggle
            label="This project"
            active={addScope === 'project'}
            onPress={() => setAddScope('project')}
            testID="settings-cred-scope-project"
          />
          <ScopeToggle
            label="Global"
            active={addScope === 'global'}
            onPress={() => setAddScope('global')}
            testID="settings-cred-scope-global"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add credential"
          disabled={adding || addService.trim().length === 0 || addToken.trim().length === 0}
          onPress={addCredential}
          style={({ pressed }) => [
            styles.primaryBtn,
            pressed && styles.pressed,
            (adding || addService.trim().length === 0 || addToken.trim().length === 0) &&
              styles.btnDisabled,
          ]}
          testID="settings-cred-add"
        >
          <Text style={styles.primaryBtnText}>{adding ? 'Saving…' : 'Add credential'}</Text>
        </Pressable>
      </View>

      {/* ── Project ───────────────────────────────────────────────────────── */}
      <Text style={[styles.sectionTitle, styles.sectionSpacer]}>Project</Text>
      {projectLoading ? (
        <View style={styles.sectionLoading} testID="settings-project-loading">
          <ActivityIndicator color={THEME.text_secondary} />
        </View>
      ) : (
        <View>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Project name"
            placeholderTextColor={THEME.text_muted}
            value={nameDraft}
            onChangeText={setNameDraft}
            onSubmitEditing={renameProject}
            accessibilityLabel="Project name"
            testID="settings-name-input"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save project name"
            disabled={!nameDirty || renaming}
            onPress={renameProject}
            style={({ pressed }) => [
              styles.primaryBtn,
              styles.saveBtn,
              pressed && styles.pressed,
              (!nameDirty || renaming) && styles.btnDisabled,
            ]}
            testID="settings-name-save"
          >
            <Text style={styles.primaryBtnText}>{renaming ? 'Saving…' : 'Save name'}</Text>
          </Pressable>

          {/* Emoji — the project's rail glyph. Edits PATCH `{ emoji }` through
              the same settings surface the name rename uses. */}
          <View style={styles.emojiRow}>
            <Text style={styles.fieldLabel}>Emoji</Text>
            <TextInput
              style={[styles.input, styles.emojiInput]}
              placeholder="📁"
              placeholderTextColor={THEME.text_muted}
              value={emojiDraft}
              onChangeText={setEmojiDraft}
              onSubmitEditing={saveEmoji}
              maxLength={16}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Project emoji"
              testID="settings-emoji-input"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save project emoji"
              disabled={!emojiDirty || savingEmoji}
              onPress={saveEmoji}
              style={({ pressed }) => [
                styles.primaryBtn,
                styles.saveBtn,
                pressed && styles.pressed,
                (!emojiDirty || savingEmoji) && styles.btnDisabled,
              ]}
              testID="settings-emoji-save"
            >
              <Text style={styles.primaryBtnText}>{savingEmoji ? 'Saving…' : 'Save emoji'}</Text>
            </Pressable>
          </View>
          {emojiError !== null ? (
            <Text style={styles.error} testID="settings-emoji-error">
              {emojiError}
            </Text>
          ) : null}

          {projectError !== null ? (
            <Text style={styles.error} testID="settings-project-error">
              {projectError}
            </Text>
          ) : null}
        </View>
      )}

      {/* ── Collaborators ─────────────────────────────────────────────────── */}
      <Text style={[styles.sectionTitle, styles.sectionSpacer]}>Collaborators</Text>
      <Text style={styles.sectionHint}>Sharing a project arrives in M2.</Text>
      {projectLoading ? null : (
        <View>
          <View style={styles.collabRow} testID="settings-collab-owner">
            <Text style={styles.collabName}>{owner?.name ?? 'Owner'}</Text>
            <Text style={styles.collabRole}>Owner</Text>
          </View>
          {/* Display-only, M2-gated. Visibly disabled — no write path. */}
          <View
            style={[styles.primaryBtn, styles.btnDisabled, styles.collabInvite]}
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            testID="settings-collab-invite-disabled"
          >
            <Text style={styles.primaryBtnText}>Invite / Remove (available in M2)</Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

/**
 * One credential row: service + optional label + scope tag, and a delete
 * control. `inherited` marks a `global` default the project reads through
 * (labeled "global default"). NEVER renders a token value — the record has
 * none.
 */
function CredentialRow({
  rec,
  inherited,
  busy,
  onDelete,
}: {
  rec: ProjectCredentialRecord;
  inherited: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <View style={styles.credRow} testID={`settings-cred-row-${rec.service}`}>
      <View style={styles.credInfo}>
        <Text style={styles.credService}>{rec.service}</Text>
        {rec.label !== null && rec.label.length > 0 ? (
          <Text style={styles.credLabel}>{rec.label}</Text>
        ) : null}
        <Text style={styles.credScope}>{inherited ? 'global default' : 'this project'}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${rec.service} credential`}
        disabled={busy}
        onPress={onDelete}
        style={({ pressed }) => [styles.deleteBtn, pressed && styles.pressed, busy && styles.btnDisabled]}
        testID={`settings-cred-delete-${rec.service}`}
      >
        <Text style={styles.deleteBtnText}>{busy ? '…' : 'Delete'}</Text>
      </Pressable>
    </View>
  );
}

/** A single scope-toggle pill for the add form. */
function ScopeToggle({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.scopePill,
        active && styles.scopePillActive,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      <Text style={[styles.scopePillText, active && styles.scopePillTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  sectionTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  sectionSpacer: { marginTop: SPACING.xl },
  sectionHint: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  sectionLoading: { paddingVertical: SPACING.lg, alignItems: 'flex-start' },

  error: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    marginTop: SPACING.sm,
  },
  empty: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    paddingVertical: SPACING.sm,
  },

  // Credential rows
  credRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  credInfo: { flex: 1, gap: SPACING.xs / 2 },
  credService: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  credLabel: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  credScope: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  deleteBtn: {
    marginLeft: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  deleteBtnText: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
  },

  // Add form
  addForm: { marginTop: SPACING.md, gap: SPACING.sm },
  input: {
    color: THEME.text_primary,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  scopeRow: { flexDirection: 'row', gap: SPACING.sm },
  scopePill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderRadius: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface,
  },
  scopePillActive: { borderColor: THEME.link, backgroundColor: THEME.surface_raised },
  scopePillText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
  },
  scopePillTextActive: { color: THEME.text_primary },

  primaryBtn: {
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md - SPACING.xs / 2,
    borderRadius: SPACING.sm,
    backgroundColor: THEME.link,
  },
  primaryBtnText: {
    color: THEME.background,
    fontWeight: '600',
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
  btnDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },

  // Project
  fieldLabel: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    marginBottom: SPACING.xs,
  },
  saveBtn: { marginTop: SPACING.sm, alignSelf: 'flex-start' },
  emojiRow: { marginTop: SPACING.lg },
  emojiInput: { alignSelf: 'flex-start', minWidth: 96, fontSize: TYPOGRAPHY.h3.fontSize },

  // Collaborators
  collabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  collabName: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  collabRole: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  collabInvite: { marginTop: SPACING.md, backgroundColor: THEME.surface_raised },
});
