/**
 * @neutronai/email-managed-core — MIME builder suite.
 *
 * Security-relevant coverage for `src/mime.ts` (D5: moved verbatim
 * out of backend.test.ts so the MIME parsing/building block owns its
 * test file): RFC 5322 serialisation + the header-injection guard
 * (Argus r1 BLOCKING history).
 */

import { describe, expect, test } from 'bun:test'

import { EmailHeaderInjectionError } from '../src/errors.ts'
import { buildRawMessage } from '../src/mime.ts'

describe('buildRawMessage', () => {
  test('serialises a minimal RFC 5322 message with To / Subject / Content-Type and CRLF line endings', () => {
    const raw = buildRawMessage({
      to: ['alice@example.com'],
      subject: 'hi',
      body: 'hello world',
    })
    expect(raw).toContain('To: alice@example.com')
    expect(raw).toContain('Subject: hi')
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8')
    expect(raw).toContain('hello world')
    expect(raw).toContain('\r\n')
  })

  test('multi-recipient + Cc + in_reply_to populates the expected headers', () => {
    const raw = buildRawMessage({
      to: ['a@x.com', 'b@x.com'],
      subject: 'Re: kickoff',
      body: 'see below',
      cc: ['c@x.com'],
      in_reply_to: '<orig-id@mail.gmail.com>',
    })
    expect(raw).toContain('To: a@x.com, b@x.com')
    expect(raw).toContain('Cc: c@x.com')
    expect(raw).toContain('In-Reply-To: <orig-id@mail.gmail.com>')
    expect(raw).toContain('References: <orig-id@mail.gmail.com>')
  })

  // Argus r1 BLOCKING — header injection. A model-generated subject
  // (or attacker-supplied address / in_reply_to) carrying CR / LF
  // would let arbitrary additional headers (Bcc, From-spoof,
  // attachments) be smuggled into the raw MIME before drafts.create.
  // We reject rather than strip so the failure is loud + auditable.
  test('rejects CRLF-injected subject — would otherwise smuggle a Bcc header', () => {
    expect(() =>
      buildRawMessage({
        to: ['alice@example.com'],
        subject: 'foo\r\nBcc: attacker@evil.com',
        body: 'body',
      }),
    ).toThrow(EmailHeaderInjectionError)
  })

  test('rejects CR / LF / NUL in to / cc / in_reply_to fields', () => {
    expect(() =>
      buildRawMessage({
        to: ['alice@example.com\nBcc: attacker@evil.com'],
        subject: 'ok',
        body: 'body',
      }),
    ).toThrow(EmailHeaderInjectionError)
    expect(() =>
      buildRawMessage({
        to: ['alice@example.com'],
        subject: 'ok',
        body: 'body',
        cc: ['cc@x.com\r\nBcc: attacker@evil.com'],
      }),
    ).toThrow(EmailHeaderInjectionError)
    expect(() =>
      buildRawMessage({
        to: ['alice@example.com'],
        subject: 'ok',
        body: 'body',
        in_reply_to: '<orig@mail.gmail.com>\r\nBcc: attacker@evil.com',
      }),
    ).toThrow(EmailHeaderInjectionError)
    expect(() =>
      buildRawMessage({
        to: ['alice@example.com'],
        subject: 'subj\0nullbyte',
        body: 'body',
      }),
    ).toThrow(EmailHeaderInjectionError)
  })

  test('the error names the field that failed sanitisation', () => {
    try {
      buildRawMessage({
        to: ['alice@example.com'],
        subject: 'foo\r\nBcc: attacker@evil.com',
        body: 'body',
      })
      throw new Error('did not throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EmailHeaderInjectionError)
      expect((err as EmailHeaderInjectionError).field).toBe('subject')
      expect((err as EmailHeaderInjectionError).code).toBe(
        'email_header_injection',
      )
    }
  })

  test('body content is NOT header-sanitised — CRLF inside the body is allowed (it IS the body delimiter)', () => {
    // Defensive guard: only HEADER fields go through the sanitiser.
    // The body itself can legitimately contain CRLF — that's how
    // multi-paragraph plaintext mail is encoded.
    const raw = buildRawMessage({
      to: ['alice@example.com'],
      subject: 'hello',
      body: 'line 1\r\nline 2\r\nline 3',
    })
    expect(raw).toContain('line 1')
    expect(raw).toContain('line 2')
    expect(raw).toContain('line 3')
  })
})
