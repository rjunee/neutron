/**
 * The foreground-presentation rule.
 *
 * This is the half that makes the server's new "notify for every chat message"
 * safe. The server stopped excluding in-turn replies at the owner's direction
 * (2026-08-15: *"I get notified for any and all chat messages if I'm not
 * actively in the app"*), and the only thing now standing between him and a
 * buzz while he types is this decision — so it is tested where it can be, not
 * inside `lib/push.ts`, which the app suite cannot import.
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  clearOpenConversation,
  decideForegroundPresentation,
  getOpenConversation,
  readNotificationProject,
  setOpenConversation,
} from '../lib/push-foreground-policy'

beforeEach(() => {
  clearOpenConversation()
})

describe('decideForegroundPresentation — do not talk over the conversation he is reading', () => {
  test('a message for the conversation ON SCREEN does not interrupt', () => {
    const p = decideForegroundPresentation({ project_id: 'neutron-open' }, { project_id: 'neutron-open' })
    expect(p.shouldShowBanner).toBe(false)
    expect(p.shouldPlaySound).toBe(false)
  })

  test('…but it still lists and badges — the interruption is suppressed, not the record', () => {
    // A banner he scrolled past while it arrived must still leave a trace
    // somewhere other than the transcript.
    const p = decideForegroundPresentation({ project_id: 'neutron-open' }, { project_id: 'neutron-open' })
    expect(p.shouldShowList).toBe(true)
    expect(p.shouldSetBadge).toBe(true)
  })

  test('a message for a DIFFERENT project interrupts, even though the app is open', () => {
    // Every other chat app shows you an in-app banner for another conversation.
    const p = decideForegroundPresentation({ project_id: 'pristine' }, { project_id: 'neutron-open' })
    expect(p.shouldShowBanner).toBe(true)
    expect(p.shouldPlaySound).toBe(true)
  })

  test('General and a project are different conversations, in both directions', () => {
    expect(decideForegroundPresentation({ project_id: null }, { project_id: 'neutron-open' }).shouldShowBanner).toBe(true)
    expect(decideForegroundPresentation({ project_id: 'neutron-open' }, { project_id: null }).shouldShowBanner).toBe(true)
  })

  test('General on screen, General message → silent', () => {
    // `null` is a real scope, not "unknown" — it must match itself.
    expect(decideForegroundPresentation({ project_id: null }, { project_id: null }).shouldShowBanner).toBe(false)
  })

  test('app open but NOT in a chat → interrupts', () => {
    // In the app on a settings screen is not "reading the conversation".
    expect(decideForegroundPresentation({ project_id: 'neutron-open' }, null).shouldShowBanner).toBe(true)
  })

  test('a payload that does not name a project INTERRUPTS — fail toward telling him', () => {
    // The cost of a redundant banner is a moment's annoyance; the cost of the
    // other mistake is a message he never learns about.
    expect(decideForegroundPresentation({}, { project_id: 'neutron-open' }).shouldShowBanner).toBe(true)
  })
})

describe('the open-conversation registry', () => {
  test('starts empty, records, and clears', () => {
    expect(getOpenConversation()).toBeNull()
    setOpenConversation({ project_id: 'neutron-open' })
    expect(getOpenConversation()).toEqual({ project_id: 'neutron-open' })
    clearOpenConversation()
    expect(getOpenConversation()).toBeNull()
  })

  test('an unset registry FAILS OPEN — he gets the banner, never silence', () => {
    // If the chat screen ever forgets to register, the failure must be a
    // redundant notification, not a missing one. Silence is the failure nobody
    // notices.
    expect(getOpenConversation()).toBeNull()
    expect(decideForegroundPresentation({ project_id: 'anything' }, getOpenConversation()).shouldShowBanner).toBe(true)
  })
})

describe('readNotificationProject — `null` is a scope, not an absence', () => {
  test('a string project survives', () => {
    expect(readNotificationProject({ project_id: 'neutron-open' })).toEqual({ project_id: 'neutron-open' })
  })

  test('an explicit null is General, NOT unknown', () => {
    // Collapsing these would make a General message present as though its
    // payload were unreadable, and it would never go silent while he reads it.
    expect(readNotificationProject({ project_id: null })).toEqual({ project_id: null })
  })

  test('missing / wrong-typed / non-object payloads read as unknown', () => {
    expect(readNotificationProject({})).toEqual({})
    expect(readNotificationProject({ project_id: 42 })).toEqual({})
    expect(readNotificationProject(null)).toEqual({})
    expect(readNotificationProject('nope')).toEqual({})
  })

  test('the unknown reading and the General reading behave DIFFERENTLY downstream', () => {
    // The distinction only earns its keep if it changes the decision.
    const open = { project_id: null }
    expect(decideForegroundPresentation(readNotificationProject({ project_id: null }), open).shouldShowBanner).toBe(false)
    expect(decideForegroundPresentation(readNotificationProject({}), open).shouldShowBanner).toBe(true)
  })
})

/**
 * General answers to three names on this client and the two sides of the
 * comparison do not agree on which they use — the payload always sends the rail
 * sentinel, the screen registers its route segment. Getting this wrong buzzes
 * him while he reads the one scope that has more than one name.
 */
describe('General is one scope however it is spelled', () => {
  const RAIL = '~general'

  test('the payload sentinel matches a screen that registered null', () => {
    expect(decideForegroundPresentation({ project_id: RAIL }, { project_id: null }).shouldShowBanner).toBe(false)
  })

  test('the payload sentinel matches a screen that registered the sentinel', () => {
    expect(decideForegroundPresentation({ project_id: RAIL }, { project_id: RAIL }).shouldShowBanner).toBe(false)
  })

  test("the payload sentinel matches a screen that registered the empty chat scope ''", () => {
    expect(decideForegroundPresentation({ project_id: RAIL }, { project_id: '' }).shouldShowBanner).toBe(false)
  })

  test('a real project is still NOT General under any spelling', () => {
    for (const open of [null, RAIL, '']) {
      expect(
        decideForegroundPresentation({ project_id: 'neutron-open' }, { project_id: open }).shouldShowBanner,
      ).toBe(true)
    }
  })
})
