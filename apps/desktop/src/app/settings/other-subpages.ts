import { isBrowserHostedDesktop } from '@/lib/platform'

// The Webapp's Gateways page is a single view (its serving host and sign-out):
// it has no connection modes, registry or managed updates to split into tasks.
const nativeHostOnly = () => !isBrowserHostedDesktop()

// Pages with separate tasks expose content-only subpages. Billing keeps its
// existing capability-gated bview=overview|plans flow rather than adding a
// second route parameter that could disagree with a pending financial action.
export const OTHER_SUBPAGES: Record<string, { id: string; labelKey: string; available?: () => boolean }[]> = {
  gateway: [
    { id: 'connection', labelKey: 'gatewayConnection', available: nativeHostOnly },
    { id: 'devices', labelKey: 'gatewayDevices', available: nativeHostOnly },
    { id: 'managed-updates', labelKey: 'gatewayManagedUpdates', available: nativeHostOnly }
  ],
  keybinds: [
    { id: 'shortcuts', labelKey: 'keyboardShortcuts' },
    { id: 'hud-gesture', labelKey: 'hudGesture' },
    { id: 'screen-capture', labelKey: 'screenCapture' }
  ],
  notifications: [
    { id: 'alerts', labelKey: 'notificationAlerts' },
    { id: 'sounds', labelKey: 'notificationSounds' }
  ],
  sessions: [
    { id: 'archived', labelKey: 'archivedSessions' },
    { id: 'default-directory', labelKey: 'defaultDirectory' }
  ],
  vault: [
    { id: 'credentials', labelKey: 'vaultCredentials' },
    { id: 'sources', labelKey: 'vaultSources' }
  ],
  about: [
    { id: 'updates', labelKey: 'appUpdates' },
    { id: 'uninstall', labelKey: 'uninstall' }
  ]
}
