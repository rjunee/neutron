/**
 * Calendar Core S1 — launcher-icon binding shape test.
 *
 * Pins the P5.3 launcher-tile metadata so a stray edit that drops
 * `primary_action` / `long_press_menu` surfaces as a typed test
 * failure before the tile silently regresses.
 */

import { describe, expect, test } from 'bun:test'

import { APP_TAB_META } from '../src/ui/app-tab-surface.ts'
import { LAUNCHER_ICON } from '../src/ui/launcher-icon.ts'

describe('LAUNCHER_ICON', () => {
  test('label + emoji preserved from v0.1.0', () => {
    expect(LAUNCHER_ICON.label).toBe('Calendar')
    expect(LAUNCHER_ICON.emoji).toBe('📅')
  })

  test('primary_action routes to the app tab', () => {
    expect(LAUNCHER_ICON.primary_action).toBe('open_app_tab')
    expect(LAUNCHER_ICON.app_tab_path).toContain('/projects/')
    expect(LAUNCHER_ICON.app_tab_path).toContain('/calendar')
  })

  test('long_press_menu has three items mirroring Notes/Tasks/Reminders pattern', () => {
    expect(LAUNCHER_ICON.long_press_menu).toHaveLength(3)
    const ids = LAUNCHER_ICON.long_press_menu.map((m) => m.id)
    expect(ids).toContain('capture')
    expect(ids).toContain('find_time')
    expect(ids).toContain('show_today')
  })

  test('capture and find_time items send /cal chat prefixes', () => {
    const capture = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'capture')
    expect(capture?.action).toBe('chat_send_prefix')
    expect(capture?.action === 'chat_send_prefix' ? capture.prefix : '').toBe(
      '/cal create ',
    )
    const findTime = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'find_time')
    expect(findTime?.action).toBe('chat_send_prefix')
    expect(findTime?.action === 'chat_send_prefix' ? findTime.prefix : '').toBe(
      '/cal find-time ',
    )
  })

  test('show_today opens the app tab directly', () => {
    const showToday = LAUNCHER_ICON.long_press_menu.find((m) => m.id === 'show_today')
    expect(showToday?.action).toBe('open_app_tab')
  })
})

describe('APP_TAB_META', () => {
  test('declares calendar tab at /projects/<project_id>/calendar', () => {
    expect(APP_TAB_META.label).toBe('Calendar')
    expect(APP_TAB_META.emoji).toBe('📅')
    expect(APP_TAB_META.path).toBe('/projects/<project_id>/calendar')
  })
})
