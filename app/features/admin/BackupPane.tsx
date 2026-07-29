/**
 * @neutronai/app — admin tab, Backup pane.
 *
 * Each project is snapshotted every 6 hours into a hidden `.project-backup/` repo.
 * Open self-hosters can also wire a remote (GitHub deploy key) for off-machine
 * disaster recovery.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  AdminClient,
  type GenerateKeypairResult,
  type ProjectBackupResult,
  type ProjectBackupStatus,
} from '../../lib/admin-client';
import { formatError, formatIso, formatNext } from './format';

interface BackupCardEntry {
  project_id: string;
  status: ProjectBackupStatus | null;
  loadError: string | null;
}

export function BackupPane({ client }: { client: AdminClient }): React.ReactElement {
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
  connectorMeta: { color: '#9a9a9a', fontSize: 12 },
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
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
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
  pressed: { opacity: 0.7 },
});
