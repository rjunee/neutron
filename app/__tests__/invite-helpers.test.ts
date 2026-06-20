/**
 * @neutronai/app — invite-helpers unit tests (M2.4).
 */

import { describe, expect, it } from 'bun:test';

import {
  canInviteToProject,
  formatInviteExpiry,
  isValidInviteeEmail,
  joinedToastCopy,
  parseJoinedToast,
} from '../lib/invite-helpers';

describe('canInviteToProject', () => {
  const owner = { user_id: 'sam', role: 'owner' as const };
  const admin = { user_id: 'admin1', role: 'admin' as const };
  const member = { user_id: 'mem1', role: 'member' as const };

  it('HIDES the pill on a personal project even for its owner', () => {
    // ~100% of prod today — owner of a solo project must NOT see Invite
    // (the mint path returns not_group / workspace_unavailable). Argus r1 BLOCKING.
    expect(
      canInviteToProject({ billing_mode: 'personal', members: [owner] }, 'sam'),
    ).toBe(false);
  });

  it('SHOWS the pill to the owner of a group (per-seat) project', () => {
    expect(
      canInviteToProject({ billing_mode: 'group_per_seat', members: [owner, member] }, 'sam'),
    ).toBe(true);
  });

  it('SHOWS the pill to the owner of a group (shared) project', () => {
    expect(
      canInviteToProject({ billing_mode: 'group_shared', members: [owner] }, 'sam'),
    ).toBe(true);
  });

  it('SHOWS the pill to an admin of a group project (owner|admin parity)', () => {
    expect(
      canInviteToProject({ billing_mode: 'group_shared', members: [owner, admin] }, 'admin1'),
    ).toBe(true);
  });

  it('HIDES the pill from a plain member of a group project', () => {
    expect(
      canInviteToProject({ billing_mode: 'group_per_seat', members: [owner, member] }, 'mem1'),
    ).toBe(false);
  });

  it('HIDES the pill from a non-member and from an anonymous (null) user', () => {
    expect(
      canInviteToProject({ billing_mode: 'group_shared', members: [owner] }, 'stranger'),
    ).toBe(false);
    expect(
      canInviteToProject({ billing_mode: 'group_shared', members: [owner] }, null),
    ).toBe(false);
  });
});

describe('isValidInviteeEmail', () => {
  it('accepts plausible addresses', () => {
    expect(isValidInviteeEmail('casey@example.com')).toBe(true);
    expect(isValidInviteeEmail('  a@b.co ')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isValidInviteeEmail('no-at')).toBe(false);
    expect(isValidInviteeEmail('a@b')).toBe(false);
    expect(isValidInviteeEmail('')).toBe(false);
    expect(isValidInviteeEmail('a b@c.co')).toBe(false);
  });
});

describe('formatInviteExpiry', () => {
  const now = 1_900_000_000_000;
  it('renders minutes under an hour', () => {
    expect(formatInviteExpiry(now + 5 * 60_000, now)).toBe('Expires in 5 min');
  });
  it('renders hours under two days', () => {
    expect(formatInviteExpiry(now + 6 * 3_600_000, now)).toBe('Expires in 6 h');
  });
  it('renders days for the 7-day default', () => {
    expect(formatInviteExpiry(now + 7 * 86_400_000, now)).toBe('Expires in 7 days');
  });
  it('singularises one day', () => {
    expect(formatInviteExpiry(now + 86_400_000, now)).toBe('Expires in 1 day');
  });
  it('reports expired in the past', () => {
    expect(formatInviteExpiry(now - 1000, now)).toBe('Expired');
  });
});

describe('parseJoinedToast', () => {
  it('returns null without a joined param', () => {
    expect(parseJoinedToast({})).toBeNull();
    expect(parseJoinedToast({ by: 'Casey' })).toBeNull();
    expect(parseJoinedToast({ joined: '  ' })).toBeNull();
  });
  it('parses project + owner', () => {
    expect(parseJoinedToast({ joined: 'Acme', by: 'Casey' })).toEqual({
      project: 'Acme',
      owner: 'Casey',
    });
  });
  it('tolerates a missing owner', () => {
    expect(parseJoinedToast({ joined: 'Acme' })).toEqual({
      project: 'Acme',
      owner: '',
    });
  });
  it('takes the first value of a repeated param', () => {
    expect(parseJoinedToast({ joined: ['Acme', 'Other'] })).toEqual({
      project: 'Acme',
      owner: '',
    });
  });
});

describe('joinedToastCopy', () => {
  it('composes message + detail with an owner', () => {
    expect(joinedToastCopy({ project: 'Acme', owner: 'Casey' })).toEqual({
      message: 'Joined Acme',
      detail: 'shared by Casey',
    });
  });
  it('omits the detail when there is no owner', () => {
    expect(joinedToastCopy({ project: 'Acme', owner: '' })).toEqual({
      message: 'Joined Acme',
      detail: '',
    });
  });
});
