import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import type { SessionInfo } from '@/types/hermes'

import { makeSessionInfo } from '../test/session-info'

import { browserTabTitle, installBrowserTabTitle } from './browser-tab-title'
import { $selectedStoredSessionId, $sessions, $unreadFinishedSessionIds, setSessions } from './session'
import { clearAllSessionStates, publishSessionState } from './session-states'
import { $sessionSeenCounts, $unreadFinishedMarkers } from './session-unread'

const row = (over: Partial<SessionInfo>): SessionInfo => makeSessionInfo({ message_count: 3, ...over })

const state = (storedId: string, over: { busy?: boolean; needsInput?: boolean } = {}) => ({
  ...createClientSessionState(storedId),
  ...over
})

let uninstall = () => {}

function reset() {
  uninstall()

  uninstall = () => {}
  clearAllSessionStates()
  $sessions.set([])
  $selectedStoredSessionId.set(null)
  $sessionSeenCounts.set({})
  $unreadFinishedMarkers.set({})
  $unreadFinishedSessionIds.set([])
  delete document.documentElement.dataset.hermesDesktopHost
  document.title = 'Hermes'
}

describe('browserTabTitle', () => {
  it('lets a blocking prompt speak over a running turn, behind the unread count', () => {
    const base = { caption: 'Fix login', needsInput: false, unread: 0, working: false }

    expect(browserTabTitle(base)).toBe('Fix login · Hermes')
    expect(browserTabTitle({ ...base, working: true })).toBe('● Fix login · Hermes')
    expect(browserTabTitle({ ...base, needsInput: true, working: true })).toBe('⚠ Fix login · Hermes')
    expect(browserTabTitle({ ...base, needsInput: true, unread: 2 })).toBe('(2) ⚠ Fix login · Hermes')
    expect(browserTabTitle({ ...base, caption: '', unread: 1 })).toBe('(1) Hermes')
  })
})

describe('installBrowserTabTitle', () => {
  beforeEach(reset)
  afterEach(reset)

  it('follows the focused session and background status in a browser host', () => {
    document.documentElement.dataset.hermesDesktopHost = 'browser'
    setSessions([row({ id: 's1', title: 'Fix login' }), row({ id: 's2', profile: 'writer', title: 'Draft essay' })])
    $selectedStoredSessionId.set('s1')
    uninstall = installBrowserTabTitle()

    expect(document.title).toBe('Fix login · Hermes')

    publishSessionState('r1', state('s1', { busy: true }))
    expect(document.title).toBe('● Fix login · Hermes')

    // Another session blocks on an approval: the whole window needs the user.
    publishSessionState('r2', state('s2', { busy: true, needsInput: true }))
    expect(document.title).toBe('⚠ Fix login · Hermes')

    // It finishes unwatched; the focused turn ends too, while being looked at.
    publishSessionState('r2', state('s2'))
    publishSessionState('r1', state('s1'))
    expect(document.title).toBe('(1) Fix login · Hermes')

    // Opening it reads it; a non-default profile names its owner.
    $selectedStoredSessionId.set('s2')
    $unreadFinishedSessionIds.set([])
    expect(document.title).toBe('Draft essay — writer · Hermes')
  })

  it('never puts unsent or untitled text in the tab', () => {
    document.documentElement.dataset.hermesDesktopHost = 'browser'
    setSessions([row({ id: 's1', preview: 'my bank password is', title: null })])
    $selectedStoredSessionId.set('s1')
    uninstall = installBrowserTabTitle()

    expect(document.title).toBe('Hermes')
  })

  it('leaves the native window title alone', () => {
    setSessions([row({ id: 's1', title: 'Fix login' })])
    $selectedStoredSessionId.set('s1')
    uninstall = installBrowserTabTitle()
    publishSessionState('r1', state('s1', { busy: true }))

    expect(document.title).toBe('Hermes')
  })
})
