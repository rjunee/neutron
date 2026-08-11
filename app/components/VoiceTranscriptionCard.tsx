/**
 * @neutronai/app — the Settings card that chooses how voice notes are transcribed.
 *
 * The mobile half of a control that until now existed ONLY in the web Settings
 * tab (`landing/chat-react/SettingsTab.tsx`). Voice notes are a phone feature,
 * so the switch that decides how they are transcribed belonged on the phone;
 * shipping it web-only meant the capability was, for a mobile owner, unreachable.
 *
 * The card is ordered by what the owner is actually asking: what is running
 * right now (one line, at the top), which one do I want (two rows), and then the
 * setup each one needs. Neither option is presented as the default — the server
 * has no precedence between them, and a UI that implied one would be lying about
 * what the box does.
 *
 * The OpenAI key field is write-only. A saved key is reported as "saved on <date>"
 * and never rendered back, not even partially: this repo's convention for stored
 * secrets is to omit them from responses rather than to mask them, so there is
 * nothing here to accidentally screenshot.
 *
 * Same server surface, same semantics, three differences the platform forces:
 *
 *   1. NO `<select>`. The model catalog renders as tappable rows, which is also
 *      the honest shape — each option's measured cost (download size, wall-clock
 *      per 30-second note, RAM) is visible BEFORE the tap, rather than hidden
 *      behind a picker that only shows a label.
 *   2. The destructive confirm is a native `Alert`, matching every other
 *      destructive action in the app (`app/integrations.tsx`).
 *   3. Progress is a plain View whose width tracks real server-reported bytes.
 *      No spinner: the download is 148 MB - 1.6 GB and a spinner over that is
 *      indistinguishable from a hang.
 *
 * Presentation decisions all live in `lib/voice-transcription-view.ts` so they
 * can be tested without mounting anything; this file is layout.
 */

import { useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type DimensionValue,
} from 'react-native';

import { type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import type {
  TranscriptionBackendChoice,
  VoiceTranscriptionStatus,
  WhisperModelOption,
} from '../lib/voice-transcription-client';
import {
  backendBlocker,
  choiceIsStalled,
  describeBackend,
  describeBackendOption,
  describeJob,
  describeKeySource,
  describeModel,
  formatBytes,
  installBlocker,
  isJobRunning,
  isSlowerThanRealTime,
  jobFraction,
  modelTitle,
  type StatusFailure,
} from '../lib/voice-transcription-view';

export interface VoiceTranscriptionCardProps {
  status: VoiceTranscriptionStatus | null;
  /** Set when the status load failed — shown INSTEAD of any control. */
  failure: StatusFailure | null;
  loading: boolean;
  /** A mutation (install/remove/choose/key) is in flight. */
  busy: boolean;
  /** Error from the last mutation attempt. */
  actionError: string | null;
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  onInstall: () => void;
  onRemove: () => void;
  onChooseBackend: (backend: TranscriptionBackendChoice) => void;
  onSaveOpenAiKey: (api_key: string) => void;
  onRemoveOpenAiKey: () => void;
}

export function VoiceTranscriptionCard(props: VoiceTranscriptionCardProps): React.JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const { status, failure, loading, busy, selectedModelId } = props;
  const running = isJobRunning(status?.job?.phase ?? null);

  return (
    <View style={styles.card} testID="settings-voice-transcription-card">
      <Text style={styles.title}>Voice transcription</Text>
      <Text style={styles.subtitle}>
        How your voice notes are turned into text. Two options, and this setting is the
        only thing that decides between them — installing one does not override the
        other.
      </Text>

      {failure !== null ? (
        <Text
          testID="settings-voice-transcription-failure"
          style={failure.kind === 'unsupported' ? styles.note : styles.error}
        >
          {failure.message}
        </Text>
      ) : loading || status === null ? (
        <Text style={styles.note} testID="settings-voice-transcription-loading">
          Checking your server…
        </Text>
      ) : (
        <Body {...props} status={status} running={running} />
      )}
    </View>
  );
}

function Body(
  props: VoiceTranscriptionCardProps & { status: VoiceTranscriptionStatus; running: boolean },
): React.JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const { status, running, busy, actionError, selectedModelId } = props;
  const blocker = installBlocker(status);
  const job = status.job;
  const stalled = choiceIsStalled(status);

  return (
    <>
      {/* WHAT IS RUNNING, at the top and in one line. Rendered in the warning
          colour whenever nothing is transcribing, because "no transcript" is
          otherwise indistinguishable from "the model was slow". */}
      <Text
        style={[styles.statusLine, status.backend === 'none' && styles.statusLineWarning]}
        testID="settings-voice-transcription-status"
      >
        {describeBackend(status)}
      </Text>

      <Text style={styles.fieldLabel}>Use</Text>
      {(['local', 'openai'] as const).map((backend) => (
        <BackendRow
          key={backend}
          backend={backend}
          selected={status.choice === backend}
          active={status.backend === backend}
          blocker={backendBlocker(status, backend)}
          disabled={busy}
          onPress={() => props.onChooseBackend(backend)}
        />
      ))}

      {stalled ? (
        <Text style={styles.warning} testID="settings-voice-transcription-stalled">
          Your choice is not running yet, and nothing has been substituted for it — set it
          up below and it starts on the next voice note.
        </Text>
      ) : null}

      {/* Live progress off real server byte counts. The download runs on the
          server, so it survives this screen closing — the bar just stops being
          watched, and picks the job back up when the app returns. */}
      {job !== null && job.phase !== 'idle' ? (
        <View style={styles.progressBlock} testID="settings-voice-transcription-progress">
          <Text style={styles.note}>{describeJob(job)}</Text>
          {job.phase !== 'failed' ? (
            <View style={styles.progressTrack}>
              <View
                testID="settings-voice-transcription-bar"
                style={[
                  styles.progressFill,
                  { width: `${Math.round((jobFraction(job) ?? 0) * 100)}%` as DimensionValue },
                ]}
              />
            </View>
          ) : (
            <Text style={styles.error}>
              {job.error?.message ?? 'The install failed.'} Nothing was installed — you can try
              again.
            </Text>
          )}
        </View>
      ) : null}

      {running ? (
        <Text style={styles.note}>
          The download runs on your server. You can leave this screen or close the app — progress
          picks up where it is when you come back.
        </Text>
      ) : null}

      {actionError !== null ? (
        <Text style={styles.error} testID="settings-voice-transcription-error">
          {actionError}
        </Text>
      ) : null}

      <Text style={styles.sectionLabel}>On this server</Text>
      {status.installed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove local Whisper"
          testID="settings-voice-transcription-remove"
          disabled={busy || running}
          onPress={() => {
            Alert.alert(
              'Remove local Whisper',
              `Delete the model and binary (${formatBytes(status.installed_bytes)})?` +
                (status.choice === 'local'
                  ? ' On-server transcription is what you chose, so voice notes stop being transcribed until you install it again or switch to OpenAI.'
                  : ' Voice notes are unaffected — they are not using this.'),
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: props.onRemove },
              ],
            );
          }}
          style={({ pressed }) => [
            styles.dangerBtn,
            (pressed || busy || running) && styles.pressed,
          ]}
        >
          <Text style={styles.dangerBtnText}>{busy ? 'Removing…' : 'Remove local Whisper'}</Text>
        </Pressable>
      ) : blocker !== null ? (
        // NOT a disabled-looking button with no explanation: the reason the
        // control cannot work is the whole message.
        <Text style={styles.note} testID="settings-voice-transcription-blocked">
          {blocker}
        </Text>
      ) : (
        <>
          <Text style={styles.fieldLabel}>Model</Text>
          {status.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={model.id === selectedModelId}
              recommended={model.id === status.default_model_id}
              disabled={busy || running}
              onPress={() => props.onSelectModel(model.id)}
            />
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Install local Whisper"
            testID="settings-voice-transcription-install"
            disabled={busy || running || selectedModelId === ''}
            onPress={props.onInstall}
            style={({ pressed }) => [
              styles.primaryBtn,
              (pressed || busy || running) && styles.pressed,
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {running ? 'Installing…' : busy ? 'Starting…' : 'Install local Whisper'}
            </Text>
          </Pressable>
        </>
      )}

      <Text style={styles.sectionLabel}>OpenAI</Text>
      <OpenAiKeyField
        status={status}
        disabled={busy}
        onSave={props.onSaveOpenAiKey}
        onRemove={props.onRemoveOpenAiKey}
      />
    </>
  );
}

/**
 * One of the two backends, as a tappable row.
 *
 * Shows THREE separate facts that are easy to conflate: whether it is what the
 * owner picked, whether it is what is actually running, and whether it could run
 * at all. They come apart exactly when something is misconfigured, which is when
 * the card has to be clearest.
 */
function BackendRow(props: {
  backend: TranscriptionBackendChoice;
  selected: boolean;
  active: boolean;
  blocker: string | null;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const { backend, selected, active, blocker, disabled } = props;
  const title = backend === 'local' ? 'This server' : 'OpenAI API';
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={title}
      testID={`settings-voice-backend-${backend}`}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.modelRow,
        selected && styles.modelRowSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.modelRadio}>{selected ? '●' : '○'}</Text>
      <View style={styles.modelText}>
        <View style={styles.rowHeader}>
          <Text style={styles.modelLabel}>{title}</Text>
          {active ? (
            <Text style={styles.activeBadge} testID={`settings-voice-backend-${backend}-active`}>
              IN USE
            </Text>
          ) : null}
        </View>
        <Text style={styles.modelNote}>{describeBackendOption(backend)}</Text>
        {blocker !== null ? (
          <Text style={styles.modelWarning} testID={`settings-voice-backend-${backend}-blocked`}>
            {blocker}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The API key field.
 *
 * Write-only by construction: there is no state here that could ever hold a
 * stored key, because the server never sends one. The draft is cleared the
 * instant a save is fired so the pasted value does not linger in a component
 * that survives a screen re-render.
 */
function OpenAiKeyField(props: {
  status: VoiceTranscriptionStatus;
  disabled: boolean;
  onSave: (api_key: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { status, disabled } = props;
  const [draft, setDraft] = useState('');
  const source = describeKeySource(status);

  return (
    <>
      {source !== null ? (
        <Text style={styles.note} testID="settings-voice-openai-key-status">
          {source}
        </Text>
      ) : (
        <Text style={styles.note}>
          Add a key from platform.openai.com to use OpenAI transcription. It is stored
          encrypted on your own server and is never shown again.
        </Text>
      )}
      <TextInput
        testID="settings-voice-openai-key-input"
        accessibilityLabel="OpenAI API key"
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder={status.openai_key.present ? 'Replace the saved key' : 'Paste your OpenAI API key'}
        placeholderTextColor={theme.text_muted}
        // A key is not a word: no autocorrect, no capitalisation, no dictionary,
        // and masked so it is not left legible on a screen someone else can see.
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save OpenAI key"
        testID="settings-voice-openai-key-save"
        disabled={disabled || draft.trim().length === 0}
        onPress={() => {
          const value = draft.trim();
          setDraft('');
          props.onSave(value);
        }}
        style={({ pressed }) => [
          styles.primaryBtn,
          (pressed || disabled || draft.trim().length === 0) && styles.pressed,
        ]}
      >
        <Text style={styles.primaryBtnText}>{status.openai_key.present ? 'Replace key' : 'Save key'}</Text>
      </Pressable>
      {status.openai_key.source === 'stored' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove OpenAI key"
          testID="settings-voice-openai-key-remove"
          disabled={disabled}
          onPress={() => {
            Alert.alert(
              'Remove OpenAI key',
              status.choice === 'openai'
                ? 'OpenAI is what you chose, so voice notes stop being transcribed until you add a key again or switch to this server.'
                : 'The key is deleted from your server. Voice notes are unaffected — they are not using it.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: props.onRemove },
              ],
            );
          }}
          style={({ pressed }) => [styles.dangerBtn, (pressed || disabled) && styles.pressed]}
        >
          <Text style={styles.dangerBtnText}>Remove key</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function ModelRow(props: {
  model: WhisperModelOption;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const { model, selected, recommended, disabled } = props;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={model.label}
      testID={`settings-voice-model-${model.id}`}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.modelRow,
        selected && styles.modelRowSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.modelRadio}>{selected ? '●' : '○'}</Text>
      <View style={styles.modelText}>
        <Text style={styles.modelLabel}>{modelTitle(model, recommended)}</Text>
        <Text style={styles.modelMeta}>{describeModel(model)}</Text>
        <Text style={isSlowerThanRealTime(model) ? styles.modelWarning : styles.modelNote}>
          {model.note}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    card: {
      gap: 10,
      padding: 16,
      borderRadius: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    title: { color: theme.text_primary, fontSize: 15, fontWeight: '600' },
    subtitle: { color: theme.text_secondary, fontSize: 12, lineHeight: 16 },
    statusLine: { color: theme.text_primary, fontSize: 13, lineHeight: 18, fontWeight: '600' },
    statusLineWarning: { color: theme.warning },
    note: { color: theme.text_secondary, fontSize: 12, lineHeight: 16 },
    warning: { color: theme.warning, fontSize: 12, lineHeight: 16 },
    error: { color: theme.danger, fontSize: 12, lineHeight: 16 },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    activeBadge: {
      color: theme.accent,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.8,
      borderWidth: 1,
      borderColor: theme.accent,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    sectionLabel: {
      color: theme.text_muted,
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: theme.hairline,
    },
    input: {
      height: 44,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.background,
      color: theme.text_primary,
      paddingHorizontal: 12,
      fontSize: 14,
    },
    progressBlock: { gap: 6 },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.surface_raised,
      overflow: 'hidden',
    },
    progressFill: { height: 6, borderRadius: 3, backgroundColor: theme.accent },
    fieldLabel: {
      color: theme.text_muted,
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginTop: 4,
    },
    modelRow: {
      flexDirection: 'row',
      gap: 10,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.background,
    },
    modelRowSelected: { borderColor: theme.accent, backgroundColor: theme.surface_raised },
    modelRadio: { color: theme.accent, fontSize: 14, lineHeight: 18 },
    modelText: { flex: 1, gap: 3 },
    modelLabel: { color: theme.text_primary, fontSize: 14, fontWeight: '600' },
    modelMeta: { color: theme.text_secondary, fontSize: 12, lineHeight: 16 },
    modelNote: { color: theme.text_muted, fontSize: 11, lineHeight: 15 },
    modelWarning: { color: theme.warning, fontSize: 11, lineHeight: 15 },
    primaryBtn: {
      height: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.accent,
      marginTop: 4,
    },
    primaryBtnText: { color: theme.accent, fontSize: 15, fontWeight: '600' },
    dangerBtn: {
      height: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.danger,
    },
    dangerBtnText: { color: theme.danger, fontSize: 15, fontWeight: '600' },
    pressed: { opacity: 0.7 },
  });
