/**
 * @neutronai/app — commandResultBody derivation (M1 E2E r3).
 *
 * Shared by BOTH the live WS `chat_command_result` handler and the HTTP-fallback
 * response path in chat-state.tsx, so a matched slash command's output is
 * rendered whether the result arrives over the socket or the `POST
 * /api/app/chat/send` fallback (socket down). Locks the text/error/empty rules.
 */
import { describe, expect, it } from 'bun:test';

import { commandResultBody } from '../lib/chat-streaming';

describe('commandResultBody', () => {
  it('prefers the result text', () => {
    expect(commandResultBody({ text: '📝 Saved note: buy milk' })).toBe('📝 Saved note: buy milk');
  });

  it('falls back to the error message when text is empty', () => {
    expect(
      commandResultBody({ text: '', error: { message: 'Recurring reminders are not supported in v1.' } }),
    ).toBe('Recurring reminders are not supported in v1.');
  });

  it('falls back to a generic line when neither text nor error message is present', () => {
    expect(commandResultBody({})).toBe('Command completed.');
    expect(commandResultBody({ text: '', error: {} })).toBe('Command completed.');
  });
});
