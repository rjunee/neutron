/**
 * @neutronai/app — top-level Settings route (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.6 + § 5.2:
 *
 *   "Settings" header. Card showing current user (avatar placeholder
 *   + displayName + email + provider tag). "Sign out" button. P5.0
 *   lists nothing else; future sprints add personality / push toggles
 *   / connector management here.
 *
 * Focus + Settings live OUTSIDE the per-project tab bar per § B.P5 of
 * the engineering plan ("Focus is a projection, not a source of
 * truth"). Project-scoped settings live in the per-project settings
 * drawer; the GLOBAL settings live here.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ServerConnectForm, type ServerSavedResult } from '../components/ServerConnectForm';
import { VoiceTranscriptionCard } from '../components/VoiceTranscriptionCard';
import { appStateBecameActive } from '../lib/app-state-refetch';
import { signOut } from '../lib/auth';
import { shouldRedirectToLogin } from '../lib/auth-helpers';
import { getRuntimeServerConfig, loadAppConfig } from '../lib/config';
import { sendDiagnosticsNow } from '../lib/diagnostics';
import {
  describeSendError,
  describeSendResult,
  type DiagnosticsSendState,
} from '../lib/diagnostics-send-state';
import { disablePushForUser } from '../lib/push';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';
import {
  VoiceTranscriptionClient,
  type TranscriptionBackendChoice,
  type VoiceTranscriptionStatus,
} from '../lib/voice-transcription-client';
import {
  describeStatusFailure,
  isJobRunning,
  type StatusFailure,
} from '../lib/voice-transcription-view';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, status, clear } = useAuthSession();
  const [editingServer, setEditingServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => loadAppConfig().gateway_base_url);
  const [sendState, setSendState] = useState<DiagnosticsSendState>('idle');
  const [sendMessage, setSendMessage] = useState('');

  // ISSUES #385 — changing the server invalidates the session (the old
  // instance minted the token). `commitServerConfig` already wiped
  // storage; drop the in-memory user and send the owner back to /login
  // so they authenticate against the NEW host.
  //
  // Keyed on `host_changed`, NOT `session_cleared` (Argus r2 MAJOR):
  // there may have been no persisted token to clear (a web reload holding
  // only in-memory state, or a session already wiped by the boot gate),
  // and in that case the old code left the owner on an authenticated-
  // looking Settings screen pointed at a brand-new host. The root layout
  // additionally re-keys the whole tree off the config epoch, so every
  // screen below this one is rebuilt against the new base too.
  const handleServerSaved = useCallback(
    (result: ServerSavedResult): void => {
      setServerUrl(result.gateway_base_url);
      setEditingServer(false);
      if (result.host_changed) {
        clear();
        router.replace('/login');
      }
    },
    [clear, router],
  );

  // ── voice transcription (which backend, plus local whisper.cpp setup) ──
  // Machine-scoped, not per-project: one choice and one install serve the whole
  // server, so this client carries no project id. The DOWNLOAD runs server-side
  // (the POST returns 202 immediately — `gateway/http/voice-transcription-surface.ts`
  // POST case), which is the only reason this is workable from a phone: the app
  // is watching a job, not hosting one. Backgrounding pauses the polling, never
  // the install.
  //
  // The BACKEND CHOICE lives here too, and it is the phone's job more than the
  // web's: voice notes are recorded on the phone, so the switch that decides
  // where the audio goes has to be reachable without opening a laptop.
  const asrClient = useMemo(
    () =>
      user === null
        ? null
        : new VoiceTranscriptionClient({ base_url: loadAppConfig().base_url, token: user.token }),
    [user],
  );
  const [asr, setAsr] = useState<VoiceTranscriptionStatus | null>(null);
  const [asrFailure, setAsrFailure] = useState<StatusFailure | null>(null);
  const [asrLoading, setAsrLoading] = useState(true);
  const [asrBusy, setAsrBusy] = useState(false);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [asrModel, setAsrModel] = useState('');

  const loadAsr = useCallback(async (): Promise<void> => {
    if (asrClient === null) return;
    try {
      const next = await asrClient.status();
      setAsr(next);
      setAsrFailure(null);
      // Seed the picker ONCE — with the installed model, else the recommended
      // default — so a poll tick can never yank a choice out from under a tap.
      setAsrModel((prev) => (prev === '' ? (next.model_id ?? next.default_model_id) : prev));
    } catch (err) {
      setAsrFailure(describeStatusFailure(err));
    } finally {
      setAsrLoading(false);
    }
  }, [asrClient]);

  useEffect(() => {
    void loadAsr();
  }, [loadAsr]);

  // Poll while the server has work in flight. Torn down the moment the job
  // leaves a running phase or the screen unmounts — no timer outlives what it
  // was watching.
  const asrRunning = isJobRunning(asr?.job?.phase ?? null);
  useEffect(() => {
    if (!asrRunning) return;
    const timer = setInterval(() => {
      void loadAsr();
    }, 1000);
    return () => clearInterval(timer);
  }, [asrRunning, loadAsr]);

  // Foreground refetch. A multi-hundred-megabyte download outlives the app's
  // foreground time on any real phone; the JS timer above does NOT run while
  // the app is backgrounded, so without this the owner returns to a bar frozen
  // at whatever it read when they left — which looks exactly like a stall. The
  // job itself is unaffected: it lives in the gateway process.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (appStateBecameActive(appState.current, next)) void loadAsr();
      appState.current = next;
    });
    return () => sub.remove();
  }, [loadAsr]);

  const handleInstallAsr = useCallback(async (): Promise<void> => {
    if (asrClient === null || asrModel === '') return;
    setAsrBusy(true);
    setAsrError(null);
    try {
      setAsr(await asrClient.install(asrModel));
    } catch (err) {
      setAsrError(describeStatusFailure(err).message);
    } finally {
      setAsrBusy(false);
    }
  }, [asrClient, asrModel]);

  const handleRemoveAsr = useCallback(async (): Promise<void> => {
    if (asrClient === null) return;
    setAsrBusy(true);
    setAsrError(null);
    try {
      setAsr(await asrClient.remove());
    } catch (err) {
      setAsrError(describeStatusFailure(err).message);
    } finally {
      setAsrBusy(false);
    }
  }, [asrClient]);

  // The three mutations that share one shape: fire, adopt the returned status,
  // report the failure in the card. They all answer with the SAME status object
  // the GET does, so there is never a re-fetch race between "what I just did"
  // and "what the server thinks".
  const runAsrMutation = useCallback(
    async (call: (c: VoiceTranscriptionClient) => Promise<VoiceTranscriptionStatus>): Promise<void> => {
      if (asrClient === null) return;
      setAsrBusy(true);
      setAsrError(null);
      try {
        setAsr(await call(asrClient));
      } catch (err) {
        setAsrError(describeStatusFailure(err).message);
      } finally {
        setAsrBusy(false);
      }
    },
    [asrClient],
  );

  const handleChooseBackend = useCallback(
    (backend: TranscriptionBackendChoice): void => {
      void runAsrMutation((c) => c.chooseBackend(backend));
    },
    [runAsrMutation],
  );

  const handleSaveOpenAiKey = useCallback(
    (api_key: string): void => {
      // The key is passed straight through to the client and never stored in
      // this screen's state, never logged, and never put in an error message —
      // `describeStatusFailure` only ever renders the server's own text.
      void runAsrMutation((c) => c.saveOpenAiKey(api_key));
    },
    [runAsrMutation],
  );

  const handleRemoveOpenAiKey = useCallback((): void => {
    void runAsrMutation((c) => c.removeOpenAiKey());
  }, [runAsrMutation]);

  useEffect(() => {
    // Only redirect to /login once the session provider has finished
    // hydrating — otherwise a fresh page-load on /settings bounces to
    // /login during the first paint even when a token exists in
    // persistent storage. Shared guard (see app/integrations.tsx).
    if (shouldRedirectToLogin({ status, user })) {
      router.replace('/login');
    }
  }, [router, status, user]);

  // Manual diagnostics push. The automatic path (queue → flush on the next
  // authenticated launch) covers crashes; this covers "the app is misbehaving
  // right now and I want you to see it", which no automatic trigger can know
  // about. Same destination, same redaction, same endpoint.
  const handleSendDiagnostics = useCallback(async () => {
    if (user === null) return;
    setSendState('sending');
    setSendMessage('');
    try {
      const cfg = loadAppConfig();
      const result = await sendDiagnosticsNow({ base_url: cfg.base_url, token: user.token });
      const described = describeSendResult(result);
      setSendState(described.state);
      setSendMessage(described.message);
    } catch (err) {
      const described = describeSendError(err);
      setSendState(described.state);
      setSendMessage(described.message);
    }
  }, [user]);

  const handleSignOut = useCallback(async () => {
    // Best-effort push-binding revocation BEFORE clearing auth state. The
    // revocation POST is bearer-authenticated, so it has to fire while the
    // current `user.token` is still valid. This is now the ONLY sign-out in the
    // app besides Focus's — the projects-list screen that carried the other copy
    // is deleted (SPEC § Decisions Log 2026-07-27).
    if (user !== null) {
      try {
        const cfg = loadAppConfig();
        await disablePushForUser({ base_url: cfg.base_url, token: user.token });
      } catch (err) {
        console.warn('[push] unexpected error during disable', err);
      }
    }
    await signOut();
    clear();
    router.replace('/login');
  }, [clear, router, user]);

  if (user === null) {
    // Either hydrating from storage (first paint after a refresh) or
    // genuinely signed out — show a neutral loading state. The
    // useEffect above handles the actual redirect once `status === 'ready'`.
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>Account</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <View style={styles.userCard} testID="settings-user-card">
          <View style={styles.avatar} accessibilityElementsHidden>
            <Text style={styles.avatarInitial}>{initial(user.displayName)}</Text>
          </View>
          <View style={styles.userText}>
            <Text style={styles.userName} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={styles.userEmail} numberOfLines={1}>
              {user.email}
            </Text>
            <View style={styles.providerBadge}>
              <Text style={styles.providerBadgeText}>{user.provider.toUpperCase()}</Text>
            </View>
          </View>
        </View>

        <View style={styles.serverCard} testID="settings-server-card">
          <Text style={styles.navRowTitle}>Neutron server</Text>
          <Text style={styles.serverUrl} numberOfLines={2} testID="settings-server-url">
            {serverUrl.length > 0 ? serverUrl : 'Not configured'}
          </Text>
          {editingServer ? (
            <ServerConnectForm
              initialUrl={serverUrl}
              initialAuthUrl={getRuntimeServerConfig().auth_base_url ?? ''}
              submitLabel="Save server"
              onSaved={handleServerSaved}
              onCancel={() => setEditingServer(false)}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change server"
              testID="settings-change-server"
              onPress={() => setEditingServer(true)}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>Change server</Text>
            </Pressable>
          )}
          <Text style={styles.navRowSubtitle}>
            Changing this signs you out. The new instance issues its own access
            token.
          </Text>
        </View>

        {/* Admin used to be a button in the projects-list header. That screen
            is deleted (SPEC § Decisions Log 2026-07-27), so /admin lives here —
            reachable as: chat header ☰ → Settings → Admin. A registered route
            nothing pushes is the ISSUES #385 defect, guarded by
            `__tests__/server-editor-reachability.test.ts`. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Admin"
          testID="settings-admin"
          onPress={() => router.push('/admin')}
          style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
        >
          <View style={styles.navRowText}>
            <Text style={styles.navRowTitle}>Admin</Text>
            <Text style={styles.navRowSubtitle}>
              Personality, gateway restart, GBrain, Cores, backups.
            </Text>
          </View>
          <Text style={styles.navRowChevron}>›</Text>
        </Pressable>

        {/* A registered route nothing pushes is the ISSUES #385 defect, so this row
            is part of the feature, not decoration —
            `__tests__/server-editor-reachability.test.ts` guards the class. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Code generation"
          testID="settings-codegen"
          onPress={() => router.push('/codegen')}
          style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
        >
          <View style={styles.navRowText}>
            <Text style={styles.navRowTitle}>Code generation</Text>
            <Text style={styles.navRowSubtitle}>
              Which model and effort run each phase of a build.
            </Text>
          </View>
          <Text style={styles.navRowChevron}>›</Text>
        </Pressable>

        {/* Placed directly above Code generation's sibling rows on purpose: the only
            reason to read quota in a settings pane is to decide where to spend it, and
            the control that spends it is the Code generation row. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Model usage"
          testID="settings-usage"
          onPress={() => router.push('/usage')}
          style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
        >
          <View style={styles.navRowText}>
            <Text style={styles.navRowTitle}>Model usage</Text>
            <Text style={styles.navRowSubtitle}>
              How much quota is left, and whether it will hold.
            </Text>
          </View>
          <Text style={styles.navRowChevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Integrations"
          testID="settings-integrations"
          onPress={() => router.push('/integrations')}
          style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
        >
          <View style={styles.navRowText}>
            <Text style={styles.navRowTitle}>Integrations</Text>
            <Text style={styles.navRowSubtitle}>
              Google accounts + API keys your Cores connect to.
            </Text>
          </View>
          <Text style={styles.navRowChevron}>›</Text>
        </Pressable>

        <VoiceTranscriptionCard
          status={asr}
          failure={asrFailure}
          loading={asrLoading}
          busy={asrBusy}
          actionError={asrError}
          selectedModelId={asrModel}
          onSelectModel={setAsrModel}
          onInstall={() => {
            void handleInstallAsr();
          }}
          onRemove={() => {
            void handleRemoveAsr();
          }}
          onChooseBackend={handleChooseBackend}
          onSaveOpenAiKey={handleSaveOpenAiKey}
          onRemoveOpenAiKey={handleRemoveOpenAiKey}
        />

        <View style={styles.serverCard} testID="settings-diagnostics-card">
          <Text style={styles.navRowTitle}>Diagnostics</Text>
          <Text style={styles.navRowSubtitle}>
            Sends recent app errors to your own Neutron server so problems can be
            diagnosed without plugging in a cable. Nothing goes to any third party,
            and access tokens are never included. Native crashes are not covered —
            those still need a device log.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send diagnostics"
            testID="settings-send-diagnostics"
            disabled={sendState === 'sending'}
            onPress={() => {
              void handleSendDiagnostics();
            }}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.pressed,
              sendState === 'sending' && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryBtnText}>
              {sendState === 'sending' ? 'Sending…' : 'Send diagnostics'}
            </Text>
          </Pressable>
          {sendMessage.length > 0 ? (
            <Text
              testID="settings-diagnostics-result"
              style={sendState === 'failed' ? styles.diagnosticsError : styles.navRowSubtitle}
            >
              {sendMessage}
            </Text>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="settings-sign-out"
          onPress={handleSignOut}
          style={({ pressed }) => [
            styles.signOutBtn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Personality and push toggles land in future P5.x sprints.
        </Text>
      </ScrollView>
    </View>
  );
}

function initial(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.slice(0, 1).toUpperCase();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 48 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  headerIcon: { color: THEME.accent, fontSize: 18, fontWeight: '600' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  headerSpacer: { width: 40 },
  headerOverline: {
    color: THEME.text_muted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headerTitle: { color: THEME.text_primary, fontSize: 18, fontWeight: '700', marginTop: 1 },
  pressed: { opacity: 0.7 },
  body: { padding: 16, gap: 16 },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: THEME.surface_raised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  avatarInitial: {
    color: THEME.text_primary,
    fontSize: 22,
    fontWeight: '700',
  },
  userText: { flex: 1, gap: 2 },
  userName: { color: THEME.text_primary, fontSize: 17, fontWeight: '600' },
  userEmail: { color: THEME.text_secondary, fontSize: 13 },
  providerBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
    marginTop: 4,
  },
  providerBadgeText: {
    color: THEME.text_secondary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  serverCard: {
    gap: 10,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  serverUrl: {
    color: THEME.text_secondary,
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  secondaryBtn: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryBtnText: { color: THEME.text_secondary, fontSize: 15, fontWeight: '600' },
  navRowText: { flex: 1, gap: 3 },
  navRowTitle: { color: THEME.text_primary, fontSize: 15, fontWeight: '600' },
  navRowSubtitle: { color: THEME.text_secondary, fontSize: 12, lineHeight: 16 },
  diagnosticsError: { color: THEME.danger, fontSize: 12, lineHeight: 16 },
  navRowChevron: { color: THEME.text_muted, fontSize: 22, fontWeight: '400' },
  signOutBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  signOutText: { color: THEME.danger, fontSize: 15, fontWeight: '600' },
  footnote: {
    color: THEME.text_muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
  },
});
