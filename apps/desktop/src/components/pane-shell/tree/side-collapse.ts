import { readJson, writeJson } from '@/lib/storage'
import { isBrowserWindow, isSecondaryWindow } from '@/store/windows'

import type { TreeSide } from './store'

// Origin-wide like layoutTree.v2, not connection/profile state. A side reveal
// must survive reload without opening the Files pane that shares its column.
const STORAGE_KEY = 'hermes.desktop.layoutTree.sides.v1'

function readSides(): Partial<Record<TreeSide, boolean>> {
  // Pop-outs neither inherit nor overwrite the primary window's layout.
  if (isSecondaryWindow() || isBrowserWindow()) {
    return {}
  }

  const value = readJson<unknown>(STORAGE_KEY)

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const saved = value as Record<string, unknown>

  return Object.fromEntries(
    ['left', 'right'].filter(side => typeof saved[side] === 'boolean').map(side => [side, saved[side]])
  )
}

/** Missing/invalid sides retain the legacy chrome default, not a guessed reveal. */
export function storedTreeSideCollapsed(side: TreeSide): boolean | undefined {
  return readSides()[side]
}

/** Persist explicit intent, including a no-op hide while Files is already off. */
export function persistTreeSideCollapsed(side: TreeSide, collapsed: boolean): void {
  if (isSecondaryWindow() || isBrowserWindow()) {
    return
  }

  const saved = readSides()

  if (saved[side] !== collapsed) {
    writeJson(STORAGE_KEY, { ...saved, [side]: collapsed })
  }
}
