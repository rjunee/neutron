/** Conversation-scoped current/list/switch control. Never changes chat identity. */
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ReplModelClient, type ReplModelState } from '../lib/repl-model-client';
import { createThemedStyles, SPACING, THEME } from '../lib/theme';

export function ReplModelControl({ projectId, baseUrl, token }: {
  projectId: string;
  baseUrl: string;
  token: string;
}): React.JSX.Element {
  const client = useMemo(() => new ReplModelClient(baseUrl, token), [baseUrl, token]);
  const [state, setState] = useState<ReplModelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async (alive: () => boolean): Promise<void> => {
    setLoading(true);
    setState(null);
    setError(null);
    try {
      const next = await client.get(projectId);
      if (alive()) setState(next);
    } catch (cause) {
      if (alive()) {
        setState(null);
        setError(cause instanceof Error ? cause.message : 'Could not load the current model.');
      }
    } finally {
      if (alive()) setLoading(false);
    }
  }, [client, projectId]);

  useFocusEffect(useCallback(() => {
    let active = true;
    void refresh(() => active);
    return () => { active = false; };
  }, [refresh]));

  const choose = async (model: string): Promise<void> => {
    if (switching || state?.status !== 'ready' || model === state.currentModel) return;
    setSwitching(true);
    setError(null);
    try {
      const next = await client.switch(projectId, model, state.sessionId);
      // A successful HTTP response is not permission to show a guessed model.
      if (next.sessionId !== state.sessionId) {
        throw new Error('The conversation changed while switching models. Refresh and try again.');
      }
      if (next.currentModel !== model) {
        throw new Error('The REPL did not confirm the selected model. Current model was refreshed.');
      }
      setState(next);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch the model.');
      // A failed command can race a session replacement. Refresh the server's
      // actual state without turning the failed command into a success claim.
      try { setState(await client.get(projectId)); } catch { /* Keep the visible error and last confirmed state. */ }
    } finally {
      setSwitching(false);
    }
  };

  return (
    <View style={styles.container} testID="repl-model-control">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Current model: ${state?.currentModel ?? 'unknown'}. Show available models`}
        accessibilityState={{ expanded: open, disabled: loading || switching || state?.status !== 'ready' }}
        testID="repl-model-open"
        disabled={loading || switching || state?.status !== 'ready'}
        onPress={() => setOpen((value) => !value)}
        style={styles.button}
      >
        <Text style={styles.text}>Model: {state?.currentModel ?? 'unknown'} ▾</Text>
        {(loading || switching) && <ActivityIndicator size="small" color={THEME.accent} />}
      </Pressable>
      {state?.status !== undefined && state.status !== 'ready' && (
        <Text testID="repl-model-status" style={styles.notice}>
          Model switching {state.status}. {state.detail ?? ''}
        </Text>
      )}
      {error !== null && <Text testID="repl-model-error" style={styles.error}>{error}</Text>}
      {(error !== null || (state !== null && state.status !== 'ready')) && !loading && (
        <Pressable accessibilityRole="button" accessibilityLabel="Retry model status" testID="repl-model-retry"
          onPress={() => void refresh(() => true)}>
          <Text style={styles.retry}>Retry</Text>
        </Pressable>
      )}
      {open && state?.status === 'ready' && (
        <View style={styles.list} testID="repl-model-list">
          {state.availableModels.map((model) => (
            <Pressable key={model.id} accessibilityRole="button"
              accessibilityLabel={`Switch to ${model.label}`}
              accessibilityState={{ selected: model.id === state.currentModel, disabled: switching }}
              testID={`repl-model-option-${model.id}`}
              disabled={switching}
              onPress={() => void choose(model.id)}
              style={styles.option}>
              <Text style={styles.text}>{model.id === state.currentModel ? '●' : '○'} {model.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = createThemedStyles({
  container: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, backgroundColor: THEME.background },
  button: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, alignSelf: 'flex-start' },
  text: { color: THEME.text_primary, fontSize: 12 },
  notice: { color: THEME.text_secondary, fontSize: 12 },
  error: { color: THEME.danger, fontSize: 12 },
  retry: { color: THEME.accent, fontSize: 12 },
  list: { paddingTop: SPACING.xs },
  option: { paddingVertical: SPACING.xs },
});
