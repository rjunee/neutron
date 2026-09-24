import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { CHAT_PROVIDER_CHOICES, chatProviderName, ProjectChatSettingsClient,
  type ProjectChatSettings as Settings, type ProjectCodexStatus } from '@neutronai/client-core/project-chat-settings.ts';
import type { FetchImpl } from '@neutronai/client-core';
import { createThemedStyles, SPACING, THEME } from '../lib/theme';

/** The project key at the mount site isolates drafts and late network replies. */
export function ProjectChatSettings({ projectId, baseUrl, token, fetchImpl }: {
  projectId: string; baseUrl: string; token: string; fetchImpl?: FetchImpl;
}) {
  const client = useMemo(() => new ProjectChatSettingsClient({ base_url: baseUrl, token, ...(fetchImpl ? { fetchImpl } : {}) }), [baseUrl, token, fetchImpl]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [credential, setCredential] = useState<ProjectCodexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [auth, setAuth] = useState('');
  const mounted = useRef(false);
  const settingsSeq = useRef(0);
  const credentialSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const seq = ++settingsSeq.current;
    const credSeq = ++credentialSeq.current;
    void client.get(projectId).then(value => {
      if (mounted.current && seq === settingsSeq.current) { setSettings(value); setError(null); }
    }).catch((err: unknown) => {
      if (mounted.current && seq === settingsSeq.current) setError(err instanceof Error ? err.message : 'Could not load chat settings');
    });
    void client.credential(projectId).then(value => {
      if (mounted.current && credSeq === credentialSeq.current) { setCredential(value); setCredentialError(null); }
    }).catch((err: unknown) => {
      if (mounted.current && credSeq === credentialSeq.current) setCredentialError(err instanceof Error ? err.message : 'Could not check Codex');
    });
    return () => { mounted.current = false; ++settingsSeq.current; ++credentialSeq.current; };
  }, [client, projectId]);

  async function select(value: typeof CHAT_PROVIDER_CHOICES[number]['value']) {
    if (busy || !settings) return;
    setBusy(true); setError(null);
    const seq = ++settingsSeq.current;
    try {
      const saved = await client.set(projectId, value === 'inherit' ? null : value);
      if (mounted.current && seq === settingsSeq.current) setSettings(saved);
    } catch (err) {
      if (mounted.current && seq === settingsSeq.current) setError(err instanceof Error ? err.message : 'Could not save chat settings');
    } finally { if (mounted.current && seq === settingsSeq.current) setBusy(false); }
  }
  async function connect() {
    if (connecting || !auth.trim()) return;
    setConnecting(true); setCredentialError(null);
    const seq = ++credentialSeq.current;
    try {
      const saved = await client.connectCredential(projectId, auth.trim());
      if (mounted.current && seq === credentialSeq.current) { setCredential(saved); setAuth(''); }
    } catch (err) {
      if (mounted.current && seq === credentialSeq.current) setCredentialError(err instanceof Error ? err.message : 'Could not connect Codex');
    } finally { if (mounted.current && seq === credentialSeq.current) setConnecting(false); }
  }
  const owner = credential?.owner_credential;
  return <View style={styles.section} testID="project-chat-settings">
    <Text style={styles.title}>Chat provider</Text>
    <Text style={styles.hint}>Choose this project’s chat harness. A configured API chat route takes precedence. Switching providers does not transfer the other provider’s conversation context.</Text>
    {CHAT_PROVIDER_CHOICES.map(choice => <Pressable key={choice.value} accessibilityRole="radio"
      accessibilityLabel={choice.label} accessibilityState={{ checked: settings !== null && (settings.project.model_provider ?? 'inherit') === choice.value, disabled: !settings || busy }}
      disabled={!settings || busy} style={styles.choice} onPress={() => { void select(choice.value); }}>
      <Text style={styles.text}>{settings !== null && (settings.project.model_provider ?? 'inherit') === choice.value ? '● ' : '○ '}{choice.label}</Text>
    </Pressable>)}
    {settings ? <Text style={styles.hint}>Effective: {chatProviderName(settings.model_provider_resolution.provider)} · {settings.model_provider_resolution.source} setting</Text> : null}
    {busy ? <Text style={styles.hint}>Saving…</Text> : null}
    {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    <Text style={styles.hint}>{owner?.detail ?? 'Project Codex credential status is unavailable.'}</Text>
    {owner ? <Text style={styles.hint}>Checked {new Date(owner.checked_at).toLocaleString()}</Text> : null}
    <Text style={styles.hint}>Codex chat needs a subscription connected to this project. An account-wide review connection is insufficient. Run codex login and paste the resulting auth.json.</Text>
    <TextInput accessibilityLabel="Project Codex auth.json" multiline autoCapitalize="none" autoCorrect={false}
      value={auth} onChangeText={setAuth} style={styles.input} placeholder="Paste project Codex auth.json" />
    <Pressable accessibilityRole="button" accessibilityLabel="Connect project Codex" disabled={connecting || !auth.trim()}
      style={styles.choice} onPress={() => { void connect(); }}>
      <Text style={styles.text}>{connecting ? 'Connecting…' : 'Connect project Codex'}</Text>
    </Pressable>
    {credentialError ? <Text style={styles.error} accessibilityRole="alert">{credentialError}</Text> : null}
  </View>;
}
const styles = createThemedStyles({
  section: { marginVertical: SPACING.lg, gap: SPACING.sm },
  title: { color: THEME.text_primary, fontSize: 18, fontWeight: '600' as const },
  text: { color: THEME.text_primary, fontSize: 15 },
  hint: { color: THEME.text_secondary, fontSize: 13 },
  error: { color: THEME.danger, fontSize: 13 },
  choice: { padding: SPACING.md, borderWidth: 1, borderColor: THEME.hairline, borderRadius: SPACING.sm },
  input: { color: THEME.text_primary, minHeight: 100, padding: SPACING.md, borderWidth: 1, borderColor: THEME.hairline },
});
