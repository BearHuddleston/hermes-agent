import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { group } from '../model'
import { $layoutTree, $narrowViewport } from '../store'

import { TreeGroup } from './tree-group'

const ids = ['workspace', 'session-tile:second', 'session-tile:third']
const disposers: (() => void)[] = []

function Host() {
  const node = useStore($layoutTree)

  return <MemoryRouter>{node?.type === 'group' && <TreeGroup node={node} />}</MemoryRouter>
}

beforeEach(() => {
  stubResizeObserver()
  stubMenuDomApis()
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  globalThis.document.documentElement.dataset.hermesDesktopHost = 'browser'
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  ids.forEach((id, i) => disposers.push(registry.register({
    area: 'panes', id, title: `Session ${i + 1}`, data: { placement: 'main' },
    render: () => <input aria-label={`Draft ${i + 1}`} defaultValue="" />
  })))
  $layoutTree.set({ ...group(ids), active: ids[0], tabStrip: 'always' })
  $narrowViewport.set(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  $layoutTree.set(null)
  $narrowViewport.set(false)
  delete globalThis.document.documentElement.dataset.hermesDesktopHost
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('exposes every phone tab and changes the active pane without discarding its draft or siblings', () => {
  render(<Host />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft 1' }), { target: { value: 'keep this draft' } })
  fireEvent.pointerDown(screen.getByRole('button', { name: '3 tabs Session 1' }), { button: 0, pointerType: 'mouse', ctrlKey: false })
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(ids.length)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Session 3' }))
  expect($layoutTree.get()).toMatchObject({ active: ids[2], panes: ids })

  fireEvent.pointerDown(screen.getByRole('button', { name: '3 tabs Session 3' }), { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Session 1' }))
  expect((screen.getByRole('textbox', { name: 'Draft 1' }) as HTMLInputElement).value).toBe('keep this draft')
  expect($layoutTree.get()).toMatchObject({ active: ids[0], panes: ids })
})

it('keeps the normal strip on wider layouts', () => {
  act(() => $narrowViewport.set(false))
  const { container } = render(<Host />)
  expect(container.querySelector('[data-slot="compact-tab-picker"]')).toBeNull()
  expect(container.querySelectorAll('[data-tree-tab]')).toHaveLength(ids.length)
})
