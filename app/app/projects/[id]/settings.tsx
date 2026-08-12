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
 *
 *      This screen READS the global defaults and never authors them
 *      (ISSUES #486). The add form used to carry a project/global toggle and
 *      every inherited row had a delete, so a credential written from inside
 *      ONE project silently changed EVERY project. Both are gone: the form
 *      writes this project, inherited rows are read-only, and the instance-wide
 *      defaults are managed on the global surface (Admin → Integrations).
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
  type ProjectCredentialRecord,
  type ProjectCredentialsList,
  type ServiceAccountSelection,
} from '../../../lib/project-credentials-client';
import { ProjectsClient, type ProjectMember } from '../../../lib/projects-client';
import { useAuthSession } from '../../../lib/session';
import { SPACING, TYPOGRAPHY, type NeutronTheme } from '../../../lib/theme';
import { useTheme, useThemedStyles } from '../../../lib/theme-context';

export default function SettingsTab() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View style={[styles.container, styles.centered]} testID="settings-bootstrapping">
        <ActivityIndicator color={theme.text_secondary} />
      </View>
    );
  }

  return <SettingsBody projectId={project_id} token={user.token} />;
}

function SettingsBody({ projectId, token }: { projectId: string; token: string }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
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

  // ── Connected accounts for THIS project (ISSUES #501) ──────────────────────
  //
  // The web Settings tab has had this since #500; mobile had no UI bound to it at
  // all, so the owner could see the enforcement but never the control.
  //
  // ⚠️ `enabled` COMES FROM THE SERVER AND IS NEVER COMPUTED HERE. The store is a
  // DISABLE list — a project with no rows reads EVERY connected account
  // (`migrations/0115`, SPEC Decisions Log 2026-08-04). Treating "no rows" as
  // "nothing selected", or writing an ENABLE list, inverts the design. Both writes
  // and reads therefore render straight from the server's computed view.
  const [acctServices, setAcctServices] = useState<ServiceAccountSelection[]>([]);
  const [acctLoading, setAcctLoading] = useState(true);
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctBusyKey, setAcctBusyKey] = useState<string | null>(null);
  const acctSeq = useRef(0);

  const refreshAccounts = useCallback((): void => {
    const mine = (acctSeq.current += 1);
    setAcctLoading(true);
    setAcctError(null);
    credClient
      .listAccounts(projectId)
      .then((services) => {
        if (mine !== acctSeq.current) return;
        setAcctServices(services);
        setAcctLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== acctSeq.current) return;
        setAcctServices([]);
        setAcctLoading(false);
        setAcctError(err instanceof Error ? err.message : 'failed to load accounts');
      });
  }, [credClient, projectId]);

  const toggleAccount = useCallback(
    (service: string, account_id: string, enabled: boolean): void => {
      const key = `${service}:${account_id}`;
      setAcctBusyKey(key);
      setAcctError(null);
      const mine = (acctSeq.current += 1);
      credClient
        .setAccountEnabled(projectId, { service, account_id, enabled })
        .then((services) => {
          setAcctBusyKey(null);
          // Bump-and-compare like the list path: a toggle that resolves after a
          // newer refresh must not overwrite it with a staler view.
          if (mine !== acctSeq.current) return;
          setAcctServices(services);
        })
        .catch((err: unknown) => {
          setAcctBusyKey(null);
          setAcctError(err instanceof Error ? err.message : 'failed to update account');
        });
    },
    [credClient, projectId],
  );

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
  }, [credClient, projectId, addService, addToken, addLabel, adding, refreshCreds]);

  useEffect((): void => {
    refreshAccounts();
  }, [refreshAccounts]);

  // Removes THIS PROJECT's credential only. An inherited global default has no
  // delete control here — removing it would change every other project.
  const deleteCredential = useCallback(
    (service: string): void => {
      setBusyCred(`project:${service}`);
      setCredActionError(null);
      credClient
        .remove(projectId, service)
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
          <ActivityIndicator color={theme.text_secondary} />
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
              onDelete={() => deleteCredential(rec.service)}
            />
          ))}
          {creds.global.map((rec) => (
            <CredentialRow key={`global:${rec.service}`} rec={rec} inherited={true} busy={false} />
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
          placeholderTextColor={theme.text_muted}
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
          placeholderTextColor={theme.text_muted}
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
          placeholderTextColor={theme.text_muted}
          value={addLabel}
          onChangeText={setAddLabel}
          accessibilityLabel="Credential label"
          testID="settings-cred-label"
        />
        <Text style={styles.sectionHint} testID="settings-cred-scope-note">
          Saved for this project only. Defaults every project inherits are managed in
          Admin → Integrations.
        </Text>
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

      {/* ── Connected accounts (ISSUES #501) ──────────────────────────────── */}
      <Text style={[styles.sectionTitle, styles.sectionSpacer]}>Connected accounts</Text>
      <Text style={styles.sectionHint}>
        Which connected accounts this project reads. Connecting an account is global; this only
        narrows where it is used. All on by default.
      </Text>

      {acctLoading ? (
        <View style={styles.sectionLoading} testID="settings-accounts-loading">
          <ActivityIndicator color={theme.text_secondary} />
        </View>
      ) : acctError !== null ? (
        <Text style={styles.error} testID="settings-accounts-error">
          {acctError}
        </Text>
      ) : acctServices.length === 0 ? (
        <Text style={styles.empty} testID="settings-accounts-empty">
          No connected accounts yet.
        </Text>
      ) : (
        <View testID="settings-accounts-list">
          {acctServices.map((svc) => (
            <View key={svc.service} style={styles.acctService}>
              <Text style={styles.acctServiceName}>{svc.service}</Text>
              {/* Mirrors the web tab's warning. All-off is reachable and legal, but
                  it silently starves the Core of every account, so it is named
                  rather than left to look like a rendering bug. */}
              {svc.accounts.length > 0 && svc.accounts.every((a) => !a.enabled) ? (
                <Text style={styles.acctAllOff} testID={`settings-accounts-alloff-${svc.service}`}>
                  Every account is off, so this project reads none of them.
                </Text>
              ) : null}
              {svc.accounts.map((acct) => {
                const key = `${svc.service}:${acct.account_id}`;
                return (
                  <Pressable
                    key={key}
                    onPress={() => toggleAccount(svc.service, acct.account_id, !acct.enabled)}
                    disabled={acctBusyKey === key}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: acct.enabled, disabled: acctBusyKey === key }}
                    accessibilityLabel={`${acct.label} for ${svc.service}`}
                    testID={`settings-account-${key}`}
                    style={({ pressed }) => [
                      styles.acctRow,
                      pressed && styles.pressed,
                      acctBusyKey === key && styles.btnDisabled,
                    ]}
                  >
                    <View style={styles.acctRowText}>
                      <Text style={styles.acctLabel}>{acct.label}</Text>
                      {acct.account_email !== null ? (
                        <Text style={styles.acctEmail}>{acct.account_email}</Text>
                      ) : null}
                    </View>
                    {/* The state is the SERVER's `enabled`, rendered — never a local
                        derivation. See the note on the state block above. */}
                    <Text
                      style={acct.enabled ? styles.acctOn : styles.acctOff}
                      testID={`settings-account-state-${key}`}
                    >
                      {acct.enabled ? 'On' : 'Off'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      )}

      {/* ── Project ───────────────────────────────────────────────────────── */}
      <Text style={[styles.sectionTitle, styles.sectionSpacer]}>Project</Text>
      {projectLoading ? (
        <View style={styles.sectionLoading} testID="settings-project-loading">
          <ActivityIndicator color={theme.text_secondary} />
        </View>
      ) : (
        <View>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Project name"
            placeholderTextColor={theme.text_muted}
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
              placeholderTextColor={theme.text_muted}
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
 * One credential row: service + optional label + scope tag, and — for THIS
 * project's own rows — a delete control. `inherited` marks a `global` default
 * the project reads through: it is labeled "global default" and carries no
 * delete, because deleting it from here would change every other project
 * (ISSUES #486). NEVER renders a token value — the record has none.
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
  onDelete?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.credRow} testID={`settings-cred-row-${rec.service}`}>
      <View style={styles.credInfo}>
        <Text style={styles.credService}>{rec.service}</Text>
        {rec.label !== null && rec.label.length > 0 ? (
          <Text style={styles.credLabel}>{rec.label}</Text>
        ) : null}
        <Text style={styles.credScope}>
          {inherited ? 'global default — manage in Admin → Integrations' : 'this project'}
        </Text>
      </View>
      {inherited ? null : (
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
      )}
    </View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    content: { padding: SPACING.md, paddingBottom: SPACING.xxl },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    sectionTitle: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h3.fontSize,
      lineHeight: TYPOGRAPHY.h3.lineHeight,
      fontWeight: TYPOGRAPHY.h3.fontWeight,
    },
    acctService: { marginTop: SPACING.sm },
    acctServiceName: {
      color: theme.text_secondary,
      fontSize: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 4,
    },
    acctAllOff: { color: theme.warning, fontSize: 12, marginBottom: 4 },
    acctRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: SPACING.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.hairline,
    },
    acctRowText: { flex: 1, minWidth: 0, paddingRight: SPACING.sm },
    acctLabel: { color: theme.text_primary, fontSize: 15 },
    acctEmail: { color: theme.text_muted, fontSize: 12, marginTop: 1 },
    acctOn: { color: theme.accent, fontSize: 13, fontWeight: '600' },
    acctOff: { color: theme.text_muted, fontSize: 13 },
    sectionSpacer: { marginTop: SPACING.xl },
    sectionHint: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      marginTop: SPACING.xs,
      marginBottom: SPACING.md,
    },
    sectionLoading: { paddingVertical: SPACING.lg, alignItems: 'flex-start' },

    error: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      marginTop: SPACING.sm,
    },
    empty: {
      color: theme.text_muted,
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
      borderBottomColor: theme.hairline,
    },
    credInfo: { flex: 1, gap: SPACING.xs / 2 },
    credService: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
      fontWeight: '600',
    },
    credLabel: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
    },
    credScope: {
      color: theme.text_muted,
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
      borderColor: theme.hairline,
    },
    deleteBtnText: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      fontWeight: '600',
    },

    // Add form
    addForm: { marginTop: SPACING.md, gap: SPACING.sm },
    input: {
      color: theme.text_primary,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    primaryBtn: {
      alignItems: 'center',
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.md - SPACING.xs / 2,
      borderRadius: SPACING.sm,
      backgroundColor: theme.link,
    },
    primaryBtnText: {
      color: theme.background,
      fontWeight: '600',
      fontSize: TYPOGRAPHY.body_small.fontSize,
    },
    btnDisabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },

    // Project
    fieldLabel: {
      color: theme.text_secondary,
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
      borderBottomColor: theme.hairline,
    },
    collabName: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    collabRole: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    collabInvite: { marginTop: SPACING.md, backgroundColor: theme.surface_raised },
  });
