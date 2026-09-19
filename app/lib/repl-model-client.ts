/** Conversation REPL model capability. The gateway owns session resolution. */
export interface ReplModelState {
  harness: 'claude-code' | 'codex';
  sessionId: string;
  currentModel: string | null;
  availableModels: { id: string; label: string }[];
  status: 'ready' | 'busy' | 'unsupported' | 'unknown';
  detail?: string;
}

export class ReplModelError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'ReplModelError';
  }
}

const TIMEOUT_MS = 15_000;

export class ReplModelClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  get(projectId: string): Promise<ReplModelState> {
    return this.request(projectId, 'GET');
  }

  switch(projectId: string, model: string, sessionId: string): Promise<ReplModelState> {
    if (sessionId.trim().length === 0) {
      return Promise.reject(new ReplModelError('invalid_session', 'No active REPL session is available to switch.', 0));
    }
    return this.request(projectId, 'POST', { model, sessionId });
  }

  private async request(
    projectId: string,
    method: 'GET' | 'POST',
    body?: { model: string; sessionId: string },
  ): Promise<ReplModelState> {
    const scope = projectId.length === 0 ? '~general' : projectId;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/app/projects/${encodeURIComponent(scope)}/repl-model`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ReplModelError(
        controller.signal.aborted ? 'timeout' : 'network',
        controller.signal.aborted ? 'Model request timed out. Try again.' :
          error instanceof Error ? error.message : 'Could not reach the server.',
        0,
      );
    } finally {
      clearTimeout(deadline);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ReplModelError('invalid_response', 'The server returned an unreadable model response.', response.status);
    }
    if (!response.ok) {
      const error = isRecord(payload) ? payload : {};
      throw new ReplModelError(
        typeof error.error === 'string' ? error.error : `http_${response.status}`,
        typeof error.detail === 'string' ? error.detail :
          typeof error.error === 'string' ? error.error : `Model request failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!isModelState(payload)) {
      throw new ReplModelError('invalid_response', 'The server returned an invalid model state.', response.status);
    }
    return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isModelState(value: unknown): value is ReplModelState {
  if (!isRecord(value)) return false;
  return (value.harness === 'claude-code' || value.harness === 'codex') &&
    typeof value.sessionId === 'string' &&
    ((value.status === 'unsupported' || value.status === 'unknown') || value.sessionId.trim().length > 0) &&
    (value.currentModel === null || typeof value.currentModel === 'string') &&
    Array.isArray(value.availableModels) &&
    value.availableModels.every((item: unknown) => isRecord(item) &&
      typeof item.id === 'string' && typeof item.label === 'string') &&
    ['ready', 'busy', 'unsupported', 'unknown'].includes(String(value.status)) &&
    (value.detail === undefined || typeof value.detail === 'string');
}
