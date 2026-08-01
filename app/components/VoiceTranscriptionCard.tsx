/**
 * @neutronai/app — the Settings card that installs local voice transcription.
 *
 * The mobile half of a control that until now existed ONLY in the web Settings
 * tab (`landing/chat-react/SettingsTab.tsx`). Voice notes are a phone feature,
 * so the switch that decides how they are transcribed belonged on the phone;
 * shipping it web-only meant the capability was, for a mobile owner, unreachable.
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

import { Alert, Pressable, StyleSheet, Text, View, type DimensionValue } from 'react-native';

import { THEME } from '../lib/theme';
import type {
  VoiceTranscriptionStatus,
  WhisperModelOption,
} from '../lib/voice-transcription-client';
import {
  describeBackend,
  describeJob,
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
  /** A mutation (install/remove) is in flight. */
  busy: boolean;
  /** Error from the last mutation attempt. */
  actionError: string | null;
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  onInstall: () => void;
  onRemove: () => void;
}

export function VoiceTranscriptionCard(props: VoiceTranscriptionCardProps): React.JSX.Element {
  const { status, failure, loading, busy, actionError, selectedModelId } = props;
  const running = isJobRunning(status?.job?.phase ?? null);

  return (
    <View style={styles.card} testID="settings-voice-transcription-card">
      <Text style={styles.title}>Local voice transcription</Text>
      <Text style={styles.subtitle}>
        Transcribe voice notes on your own server with whisper.cpp — no API key, no
        per-minute cost, and the audio never leaves the machine. Once installed it is
        used instead of hosted OpenAI transcription, even if an OpenAI key is set.
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
  const { status, running, busy, actionError, selectedModelId } = props;
  const blocker = installBlocker(status);
  const job = status.job;

  return (
    <>
      <Text style={styles.statusLine} testID="settings-voice-transcription-status">
        {describeBackend(status)}
      </Text>

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

      {status.installed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove local Whisper"
          testID="settings-voice-transcription-remove"
          disabled={busy || running}
          onPress={() => {
            Alert.alert(
              'Remove local Whisper',
              `Delete the model and binary (${formatBytes(status.installed_bytes)})? Voice notes fall back to hosted transcription, or none.`,
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

const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  title: { color: THEME.text_primary, fontSize: 15, fontWeight: '600' },
  subtitle: { color: THEME.text_secondary, fontSize: 12, lineHeight: 16 },
  statusLine: { color: THEME.text_primary, fontSize: 13, lineHeight: 18 },
  note: { color: THEME.text_secondary, fontSize: 12, lineHeight: 16 },
  error: { color: THEME.danger, fontSize: 12, lineHeight: 16 },
  progressBlock: { gap: 6 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: THEME.surface_raised,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: THEME.accent },
  fieldLabel: {
    color: THEME.text_muted,
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
    borderColor: THEME.hairline,
    backgroundColor: THEME.background,
  },
  modelRowSelected: { borderColor: THEME.accent, backgroundColor: THEME.surface_raised },
  modelRadio: { color: THEME.accent, fontSize: 14, lineHeight: 18 },
  modelText: { flex: 1, gap: 3 },
  modelLabel: { color: THEME.text_primary, fontSize: 14, fontWeight: '600' },
  modelMeta: { color: THEME.text_secondary, fontSize: 12, lineHeight: 16 },
  modelNote: { color: THEME.text_muted, fontSize: 11, lineHeight: 15 },
  modelWarning: { color: THEME.warning, fontSize: 11, lineHeight: 15 },
  primaryBtn: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.accent,
    marginTop: 4,
  },
  primaryBtnText: { color: THEME.accent, fontSize: 15, fontWeight: '600' },
  dangerBtn: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  dangerBtnText: { color: THEME.danger, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
