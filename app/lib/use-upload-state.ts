/**
 * @neutronai/app — chat upload-modal lifecycle hook.
 *
 * Extracted from the (now-collapsed) legacy chat route so the single
 * Telegram-grade surface ({@link ChatSyncSurface}) owns the SAME upload UX:
 * the modal-visibility flag, the latest progress snapshot, the AbortController,
 * and the auto-dismiss timer. RN-free except React hooks + the upload client.
 *
 * State transitions:
 *   start()  → visible, phase=uploading
 *   progress → bytes_sent updated; 'uploading' until 100% then 'processing'
 *   complete → 'analyzing' for ZIPs (engine.notifyImportUpload takes over
 *              server-side; auto-dismiss after a beat) or 'complete' + the
 *              onImageUploaded handoff (send({attachments:[url]})) for images.
 *   error    → 'error', sticky, retry/dismiss.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { type UploadModalPhase } from '../components/UploadModal';
import { uploadAttachment, type UploadKind, type UploadProgress } from './upload-client';

export interface UploadStartArgs {
  uri: string;
  name: string;
  mime_type: string;
  size_bytes?: number;
  kind: UploadKind;
}

export interface UseUploadStateInput {
  base_url: string;
  token: string | null;
  topic_id: string | null;
  onImageUploaded: (url: string, mime: string) => Promise<void>;
}

export interface UploadStateValue {
  visible: boolean;
  phase: UploadModalPhase;
  filename: string;
  kind: 'history-import-zip' | 'image';
  mime_type?: string;
  bytes_sent?: number;
  bytes_total?: number;
  error_message?: string;
  start: (args: UploadStartArgs) => void;
  cancel: () => void;
  retry: () => void;
  dismiss: () => void;
}

export function useUploadState(input: UseUploadStateInput): UploadStateValue {
  const [snapshot, setSnapshot] = useState<{
    visible: boolean;
    phase: UploadModalPhase;
    filename: string;
    kind: 'history-import-zip' | 'image';
    mime_type?: string;
    bytes_sent?: number;
    bytes_total?: number;
    error_message?: string;
  }>({
    visible: false,
    phase: 'uploading',
    filename: '',
    kind: 'image',
  });

  const abortRef = useRef<AbortController | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStartRef = useRef<UploadStartArgs | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const performUpload = useCallback(
    async (args: UploadStartArgs) => {
      if (input.token === null) {
        setSnapshot((s) => ({ ...s, phase: 'error', error_message: 'Not signed in.' }));
        return;
      }
      const abort = new AbortController();
      abortRef.current = abort;
      const onProgress = (p: UploadProgress): void => {
        if (p.phase === 'started') {
          setSnapshot((s) => ({
            ...s,
            visible: true,
            phase: 'uploading',
            ...(p.bytes_total !== undefined ? { bytes_total: p.bytes_total } : {}),
          }));
          return;
        }
        if (p.phase === 'progress') {
          setSnapshot((s) => {
            const fraction =
              typeof p.bytes_total === 'number' && p.bytes_total > 0
                ? p.bytes_sent / p.bytes_total
                : undefined;
            const next_phase: UploadModalPhase =
              fraction !== undefined && fraction >= 1 ? 'processing' : 'uploading';
            return {
              ...s,
              phase: next_phase,
              bytes_sent: p.bytes_sent,
              ...(p.bytes_total !== undefined ? { bytes_total: p.bytes_total } : {}),
            };
          });
          return;
        }
        if (p.phase === 'complete') {
          if (args.kind === 'history-import-zip') {
            setSnapshot((s) => ({
              ...s,
              phase: 'analyzing',
              bytes_sent: s.bytes_total,
            }));
            dismissTimerRef.current = setTimeout(() => {
              setSnapshot((s) => ({ ...s, visible: false }));
            }, 2500);
          } else {
            setSnapshot((s) => ({
              ...s,
              phase: 'complete',
              bytes_sent: s.bytes_total,
            }));
            void input
              .onImageUploaded(p.url, snapshot.mime_type ?? args.mime_type)
              .catch(() => undefined);
            dismissTimerRef.current = setTimeout(() => {
              setSnapshot((s) => ({ ...s, visible: false }));
            }, 1000);
          }
          return;
        }
        if (p.phase === 'error') {
          setSnapshot((s) => ({
            ...s,
            phase: 'error',
            error_message: `${p.code}: ${p.message}`,
          }));
        }
      };
      const result = await uploadAttachment({
        uri: args.uri,
        name: args.name,
        mime_type: args.mime_type,
        token: input.token,
        base_url: input.base_url,
        ...(input.topic_id !== null ? { topic_id: input.topic_id } : {}),
        abort_signal: abort.signal,
        onProgress,
      });
      if (result === null && !abort.signal.aborted) {
        return;
      }
    },
    [input, snapshot.mime_type],
  );

  const start = useCallback(
    (args: UploadStartArgs) => {
      clearDismissTimer();
      abortRef.current?.abort();
      lastStartRef.current = args;
      setSnapshot({
        visible: true,
        phase: 'uploading',
        filename: args.name,
        mime_type: args.mime_type,
        kind: args.kind,
        ...(args.size_bytes !== undefined ? { bytes_total: args.size_bytes } : {}),
        bytes_sent: 0,
      });
      void performUpload(args);
    },
    [performUpload, clearDismissTimer],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    clearDismissTimer();
    setSnapshot((s) => ({ ...s, visible: false }));
  }, [clearDismissTimer]);

  const retry = useCallback(() => {
    const last = lastStartRef.current;
    if (last === null) return;
    start(last);
  }, [start]);

  const dismiss = useCallback(() => {
    clearDismissTimer();
    setSnapshot((s) => ({ ...s, visible: false }));
  }, [clearDismissTimer]);

  useEffect(
    () => () => {
      clearDismissTimer();
      abortRef.current?.abort();
    },
    [clearDismissTimer],
  );

  return {
    visible: snapshot.visible,
    phase: snapshot.phase,
    filename: snapshot.filename,
    kind: snapshot.kind,
    ...(snapshot.mime_type !== undefined ? { mime_type: snapshot.mime_type } : {}),
    ...(snapshot.bytes_sent !== undefined ? { bytes_sent: snapshot.bytes_sent } : {}),
    ...(snapshot.bytes_total !== undefined ? { bytes_total: snapshot.bytes_total } : {}),
    ...(snapshot.error_message !== undefined ? { error_message: snapshot.error_message } : {}),
    start,
    cancel,
    retry,
    dismiss,
  };
}
