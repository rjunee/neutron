/**
 * @neutronai/app — root React error boundary.
 *
 * WHY: a throw during render is not caught by `ErrorUtils` in a useful way — it
 * unmounts the tree and the user gets a blank screen with no message. "The app
 * opens to a black screen" is exactly the report that cost hours of guessing,
 * because a blank screen carries no information at all.
 *
 * With this boundary the same failure (a) records the component stack into a
 * report that is persisted immediately and delivered on the next authenticated
 * launch, and (b) shows the owner what happened plus a way to retry, instead of
 * nothing.
 *
 * A class component because that is still the only way to implement
 * `componentDidCatch` — there is no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { captureReport, recordDiagnosticEvent } from '../lib/diagnostics';
import { THEME } from '../lib/theme';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class DiagnosticsErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    recordDiagnosticEvent({
      kind: 'render_crash',
      level: 'error',
      message: `${error.name}: ${error.message}`,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
      context: { component_stack: info.componentStack ?? null },
    });
    // Persist NOW. A render crash often precedes the user force-quitting, so
    // the report has to survive the process going away.
    void captureReport('render_crash').catch(() => undefined);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <View style={styles.container} testID="diagnostics-error-boundary">
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>Something broke</Text>
          <Text style={styles.subtitle}>
            The error has been saved and will be sent to your own Neutron server the
            next time you sign in. Nothing was sent anywhere else.
          </Text>
          <View style={styles.card}>
            <Text style={styles.errorText} selectable>
              {error.name}: {error.message}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            testID="diagnostics-error-retry"
            onPress={this.handleRetry}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 72 },
  body: { padding: 24, gap: 16 },
  title: { color: THEME.text_primary, fontSize: 22, fontWeight: '700' },
  subtitle: { color: THEME.text_secondary, fontSize: 14, lineHeight: 20 },
  card: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  errorText: { color: THEME.text_secondary, fontSize: 12, fontFamily: 'Menlo' },
  retryBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  retryText: { color: THEME.accent, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
