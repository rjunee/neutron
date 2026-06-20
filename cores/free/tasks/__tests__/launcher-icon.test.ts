import { describe, expect, test } from 'bun:test'

import { APP_TAB_META, LAUNCHER_ICON } from '../index.ts'

describe('Tasks Core — launcher icon (P5.3 binding)', () => {
  test('exposes label + emoji forward-compat with the existing composer', () => {
    expect(LAUNCHER_ICON.label).toBe('Tasks')
    expect(LAUNCHER_ICON.emoji).toBe('✅')
  })

  test('primary_action is open_app_tab', () => {
    expect(LAUNCHER_ICON.primary_action).toBe('open_app_tab')
  })

  test('app_tab_path points at the existing P5.4 tasks tab', () => {
    expect(LAUNCHER_ICON.app_tab_path).toBe('/projects/<project_id>/tasks')
  })

  test('long_press_menu has the 3 locked entries (capture / browse / pick_next)', () => {
    const ids = LAUNCHER_ICON.long_press_menu.map((m) => m.id)
    expect(ids).toEqual(['capture', 'browse', 'pick_next'])

    const capture = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'capture')
    expect(capture?.action).toBe('chat_send_prefix')
    if (capture !== undefined && capture.action === 'chat_send_prefix') {
      expect(capture.prefix).toBe('/task ')
    }

    const browse = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'browse')
    expect(browse?.action).toBe('open_app_tab')

    const pickNext = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'pick_next')
    expect(pickNext?.action).toBe('chat_send')
    if (pickNext !== undefined && pickNext.action === 'chat_send') {
      expect(pickNext.text).toBe('/task focus')
    }
  })
})

describe('Tasks Core — app_tab UI surface metadata', () => {
  test('APP_TAB_META aligns with the manifest props_schema', () => {
    expect(APP_TAB_META.path).toBe('/projects/<project_id>/tasks')
    expect(APP_TAB_META.label).toBe('Tasks')
    expect(APP_TAB_META.emoji).toBe('✅')
    expect(APP_TAB_META.order).toBe(30)
  })
})
