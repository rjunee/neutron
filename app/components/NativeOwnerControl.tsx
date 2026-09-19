import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { NativeOwnerControlClient, isRecord, ownerIdentity,
  type NativeOwnerAction, type NativeOwnerControlState, type NativeOwnerQuestion } from '../lib/native-owner-control-client';
import { createThemedStyles, SPACING, THEME } from '../lib/theme';

/** The same native turn projected in chat on web and mobile. */
export function NativeOwnerControl({ projectId, baseUrl, token }: {
  projectId: string; baseUrl: string; token: string;
}): React.JSX.Element {
  const client = useMemo(() => new NativeOwnerControlClient(baseUrl, token), [baseUrl, token]);
  const [state, setState] = useState<NativeOwnerControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const reading = useRef<number | null>(null);
  const focused = useRef(false);

  const refresh = useCallback(async () => {
    if (!focused.current || inFlight.current || reading.current !== null) return;
    const version = ++generation.current;
    reading.current = version;
    try {
      const next = await client.get(projectId);
      if (generation.current === version && focused.current) setState(next);
    } catch (cause) {
      if (generation.current === version && focused.current) {
        setState(null);
        setError(cause instanceof Error ? cause.message : 'Could not load Codex controls.');
      }
    } finally { if (reading.current === version) reading.current = null; }
  }, [client, projectId]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    inFlight.current = false;
    reading.current = null;
    setState(null); setError(null); setSending(false);
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => { focused.current = false; generation.current += 1; clearInterval(timer); };
  }, [refresh]));

  const act = async (action: NativeOwnerAction) => {
    if (!state || inFlight.current || !focused.current) return;
    inFlight.current = true; setSending(true); setError(null);
    reading.current = null;
    const version = ++generation.current;
    try {
      const next = await client.act(state, action);
      if (generation.current !== version || !focused.current) return;
      // A valid response from a replacement conversation is not an acknowledgement.
      if (next.threadId !== state.threadId || next.bindingRevision !== state.bindingRevision || next.generation !== state.generation) {
        throw new Error('The Codex conversation changed. Refresh before acting again.');
      }
      setState(next);
    } catch (cause) {
      if (generation.current !== version || !focused.current) return;
      setState(null);
      setError(cause instanceof Error ? cause.message : 'Could not send the Codex action.');
      // Never retry a write: an uncertain answer might already have reached Codex.
    } finally {
      if (generation.current === version && focused.current) {
        inFlight.current = false; setSending(false);
        void refresh();
      }
    }
  };

  return <View style={styles.container} testID="native-owner-control">
    {error && <Text style={styles.error} testID="native-owner-error">{error}</Text>}
    {error && <Pressable accessibilityRole="button" testID="native-owner-refresh" disabled={sending}
      onPress={() => { setError(null); void refresh(); }}><Text style={styles.action}>Refresh Codex controls</Text></Pressable>}
    {state?.turnId && <Pressable accessibilityRole="button" accessibilityLabel="Interrupt Codex turn"
      testID="native-owner-interrupt" disabled={sending} onPress={() => void act({ action: 'interrupt' })}>
      <Text style={styles.action}>Interrupt Codex</Text>
    </Pressable>}
    {state?.pending.map(question => <NativeQuestion key={`${JSON.stringify(ownerIdentity(state))}:${typeof question.requestId}:${question.requestId}`}
      question={question} sending={sending} reply={result => void act({ action: 'reply', requestId: question.requestId, result })} />)}
  </View>;
}

function NativeQuestion({ question, sending, reply }: {
  question: NativeOwnerQuestion; sending: boolean; reply(result: unknown): void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(question.method);
  const questions = question.method === 'item/tool/requestUserInput' && Array.isArray(question.params.questions)
    ? question.params.questions.filter(isRecord) : [];
  const supportedInput = questions.length > 0 && questions.every(q => typeof q.id === 'string' && q.id.length > 0 && typeof q.question === 'string');
  const decisions = ['accept', 'decline', 'cancel'].filter(decision =>
    !Array.isArray(question.params.availableDecisions) || question.params.availableDecisions.includes(decision));
  return <View testID="native-owner-question" style={styles.question}>
    <Text style={styles.text}>Codex needs your answer</Text>
    {[question.params.reason, question.params.command].filter((value): value is string => typeof value === 'string').map((value, index) =>
      <Text key={index} style={styles.text}>{value}</Text>)}
    {approval && decisions.length > 0 ? decisions.map(decision => <Pressable key={decision} accessibilityRole="button"
      testID={`native-owner-${decision}`} disabled={sending} onPress={() => reply({ decision })}>
      <Text style={styles.action}>{decision === 'accept' ? 'Allow once' : decision === 'decline' ? 'Decline' : 'Cancel'}</Text>
    </Pressable>) : supportedInput ? <>
      {questions.map(q => <View key={String(q.id)}>
        <Text style={styles.text}>{String(q.question)}</Text>
        {Array.isArray(q.options) && q.options.filter(isRecord).map((option, index) => typeof option.label === 'string' &&
          <Pressable key={index} accessibilityRole="button" disabled={sending}
            onPress={() => setAnswers(previous => ({ ...previous, [String(q.id)]: String(option.label) }))}>
            <Text style={styles.action}>{option.label}{typeof option.description === 'string' ? ` — ${option.description}` : ''}</Text>
          </Pressable>)}
        <TextInput accessibilityLabel={String(q.question)} testID={`native-owner-answer-${q.id}`}
          secureTextEntry={q.isSecret === true} editable={!sending} value={answers[String(q.id)] ?? ''}
          onChangeText={value => setAnswers(previous => ({ ...previous, [String(q.id)]: value }))} style={styles.input} />
      </View>)}
      <Pressable accessibilityRole="button" testID="native-owner-submit" disabled={sending || questions.some(q => !answers[String(q.id)]?.trim())}
        onPress={() => reply({ answers: Object.fromEntries(questions.map(q => [String(q.id), { answers: [answers[String(q.id)]] }])) })}>
        <Text style={styles.action}>Send answer</Text>
      </Pressable>
    </> : <Text style={styles.text}>This question needs an answer in the Codex terminal.</Text>}
  </View>;
}

const styles = createThemedStyles({
  container: { paddingHorizontal: SPACING.sm, backgroundColor: THEME.background },
  question: { paddingVertical: SPACING.sm, gap: SPACING.xs },
  text: { color: THEME.text_primary, fontSize: 13 },
  action: { color: THEME.accent, paddingVertical: SPACING.xs, fontSize: 13 },
  error: { color: THEME.danger, fontSize: 12 },
  input: { color: THEME.text_primary, borderWidth: 1, borderColor: THEME.text_secondary, padding: SPACING.xs },
});
