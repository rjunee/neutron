/** Read and act on the existing native owner; never create a session. */
import { httpScopeSegmentEncoded, RAIL_GENERAL_ID } from './general-scope';

export interface NativeOwnerIdentity {
  projectId: string | null;
  threadId: string;
  bindingRevision: string;
  generation: number;
  epoch: number;
  turnId: string | null;
}
export interface NativeOwnerQuestion {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
}
export interface NativeOwnerControlState extends NativeOwnerIdentity {
  status: string;
  pending: NativeOwnerQuestion[];
}
export type NativeOwnerAction = { action: 'interrupt' } |
  { action: 'reply'; requestId: string | number; result: unknown };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function isState(value: unknown, projectId: string | null): value is NativeOwnerControlState {
  return isRecord(value) && value.projectId === projectId && nonempty(value.threadId) &&
    nonempty(value.bindingRevision) && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 &&
    Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0 &&
    (value.turnId === null || nonempty(value.turnId)) && nonempty(value.status) &&
    Array.isArray(value.pending) && value.pending.every(question => isRecord(question) &&
      (nonempty(question.requestId) || Number.isSafeInteger(question.requestId)) &&
      nonempty(question.method) && isRecord(question.params) &&
      value.turnId !== null && question.params.threadId === value.threadId && question.params.turnId === value.turnId);
}

export function ownerIdentity(state: NativeOwnerIdentity): NativeOwnerIdentity {
  const { projectId, threadId, bindingRevision, generation, epoch, turnId } = state;
  return { projectId, threadId, bindingRevision, generation, epoch, turnId };
}

export class NativeOwnerControlClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  get(projectId: string): Promise<NativeOwnerControlState> {
    // Route/client spelling changes at entry; native identity remains null for General.
    return this.request(projectId === RAIL_GENERAL_ID || projectId.length === 0 ? null : projectId);
  }

  act(state: NativeOwnerControlState, action: NativeOwnerAction): Promise<NativeOwnerControlState> {
    if (!state.turnId) return Promise.reject(new Error('No active Codex turn. Refresh the controls.'));
    return this.request(state.projectId, { ...ownerIdentity(state), ...action });
  }

  private async request(projectId: string | null, body?: NativeOwnerIdentity & NativeOwnerAction): Promise<NativeOwnerControlState> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/app/projects/${httpScopeSegmentEncoded(projectId)}/repl-control`, {
        method: body ? 'POST' : 'GET', signal: controller.signal,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(value) && typeof value.message === 'string'
        ? value.message : 'Codex controls are unavailable. Refresh to try again.');
      if (!isState(value, projectId)) throw new Error('The server returned invalid Codex control state.');
      return value;
    } finally { clearTimeout(timeout); }
  }
}
