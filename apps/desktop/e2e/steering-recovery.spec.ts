/** A late recovery belongs to the steered chat, not the newly selected chat. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { TestInfo } from '@playwright/test'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, type MockBackendFixture, waitForAppReady, writeEnvFile, writeMockProviderConfig } from './fixtures'
import { collectErrorBanners, expect, type Page, test } from './test'

const SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'
const CHAT_A = 'E2E recovery destination A'
const CHAT_B = 'E2E recovery source B'
const RUNNING = 'E2E_RECOVERY_HELD_TURN'
const CORRECTION = 'E2E correction sent to B before selecting A'
const MARKER = 'E2E ordinary send after selecting A'
const REPLY = 'MOCK ONLY: fixture turn completed.'
const DESTINATION_ID = 'e2e-recovery-destination'
const SOURCE_ID = 'e2e-recovery-source'
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function pythonBinary(): string {
  if (process.env.HERMES_DESKTOP_PYTHON) {
    return process.env.HERMES_DESKTOP_PYTHON
  }

  const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const candidate = ['.venv', 'venv'].map(dir => path.join(REPO_ROOT, dir, ...suffix)).find(file => fs.existsSync(file))

  if (!candidate) {
    throw new Error('Create the repo Python venv or set HERMES_DESKTOP_PYTHON before running this spec')
  }

  return candidate
}

interface RpcFrame {
  id?: number | string
  method?: string
  params?: { session_id?: string; text?: string; type?: string; payload?: { status?: string } }
  result?: { session_id?: string; resumed?: string; running?: boolean; status?: string }
  error?: unknown
}

function surface(page: Page) {
  return page.locator(SURFACE).last()
}

async function send(page: Page, text: string): Promise<void> {
  const composer = surface(page).locator('[data-slot="composer-root"]')
  await composer.locator('[contenteditable="true"]').first().fill(text)
  await composer.locator('button[type="submit"]').click()
}

async function openChat(page: Page, title: string): Promise<void> {
  await page.locator('[data-slot="sidebar"] button').filter({ hasText: title }).first().click()
  await expect(surface(page).locator('[data-slot="aui_thread-viewport"]')).toContainText(title)
}

// A separate read-only connection checks the durable owner, not renderer caches.
function markerOwners(fixture: MockBackendFixture): string[] {
  const script = [
    'import json, sqlite3, sys',
    'from pathlib import Path',
    'with sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True) as db:',
    '    print(json.dumps([r[0] for r in db.execute("SELECT session_id FROM messages WHERE role = ? AND content = ? ORDER BY id", ("user", sys.argv[2]))]))',
  ].join('\n')

  return JSON.parse(execFileSync(pythonBinary(), ['-c', script, path.join(fixture.sandbox.hermesHome, 'state.db'), MARKER], {
    env: { ...process.env, HERMES_HOME: fixture.sandbox.hermesHome },
    encoding: 'utf8',
  })) as string[]
}

let fixture: MockBackendFixture
let releaseResume: (() => void) | undefined

test.beforeEach(async () => {
  const sandbox = createSandbox('steering-recovery')
  const mock = await startMockServer({ holdFirstStreamForPrompt: RUNNING, replyForPrompt: () => REPLY })
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  const env = buildAppEnv(sandbox)

  // Prewritten user history only; never seed invented assistant/tool results.
  // Both runtime bindings and all navigation still go through the real UI.
  const script = [
    'import json, sys',
    'from hermes_state import SessionDB',
    'db = SessionDB()',
    'for sid, title in json.loads(sys.argv[1]):',
    '    db.create_session(sid, source="desktop")',
    '    db.set_session_title(sid, title)',
    '    db.append_message(sid, "user", "PREWRITTEN E2E HISTORY: " + title)',
    'db.close()',
  ].join('\n')

  execFileSync(pythonBinary(), ['-c', script, JSON.stringify([[DESTINATION_ID, CHAT_A], [SOURCE_ID, CHAT_B]])], {
    cwd: REPO_ROOT, env,
  })
  const { app, page } = await launchDesktop(env)
  fixture = {
    app, page, mock, sandbox, mockUrl: mock.url,
    cleanup: async () => {
      await app.close()
      await mock.close()
      sandbox.cleanup()
    },
  }
  await waitForAppReady(fixture, 120_000)
})

test.afterEach(async () => {
  releaseResume?.()
  releaseResume = undefined
  fixture?.mock.releaseHeldStream()

  if (fixture) {
    const errors = await collectErrorBanners(fixture.page)
    await fixture.cleanup()
    expect(errors).toEqual([])
  }
})

// Playwright requires a destructured first argument even without fixtures.
// eslint-disable-next-line no-empty-pattern
test('late steering recovery cannot steal the foreground or the next ordinary send', async ({}, testInfo: TestInfo) => {
  test.setTimeout(180_000)
  const { page, mock } = fixture
  const requests: RpcFrame[] = []
  const completions: RpcFrame[] = []
  const retries: RpcFrame[] = []
  const runtimeByStoredId = new Map<string, string>()
  let fault: RpcFrame | undefined
  let held: { request: RpcFrame; response: RpcFrame } | undefined

  await page.routeWebSocket('**', socket => {
    const server = socket.connectToServer()
    // Request ids restart on reconnect, so correlation is per socket.
    const pending = new Map<number | string, RpcFrame>()

    socket.onMessage(data => {
      const frame = JSON.parse(data.toString()) as RpcFrame

      if (frame.id !== undefined) {
        pending.set(frame.id, frame)
      }

      if (['prompt.submit', 'session.redirect', 'session.resume'].includes(frame.method ?? '')) {
        requests.push(frame)
      }

      if (!fault && frame.method === 'session.redirect' && frame.params?.text === CORRECTION) {
        fault = frame
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4001, message: 'session not found (controlled E2E fault)' } }))

        return
      }

      server.send(data)
    })
    server.onMessage(data => {
      const frame = JSON.parse(data.toString()) as RpcFrame
      const request = frame.id === undefined ? undefined : pending.get(frame.id)

      if (frame.id !== undefined) {
        pending.delete(frame.id)
      }

      if (frame.params?.type === 'message.complete') {
        completions.push(frame)
      }

      if (request?.method === 'session.redirect' && request.params?.text === CORRECTION) {
        retries.push(frame)
      }

      if (request?.method === 'session.resume' && request.params?.session_id && frame.result?.session_id) {
        runtimeByStoredId.set(request.params.session_id, frame.result.session_id)
      }

      if (fault && !held && request?.method === 'session.resume' && request.params?.session_id === SOURCE_ID) {
        held = { request, response: frame }

        // Delay the REAL backend response without replacing its runtime id.
        releaseResume = () => {
          releaseResume = undefined
          socket.send(data)
        }

        return
      }

      socket.send(data)
    })
  })

  try {
    await collectErrorBanners(page)
    await page.reload()
    await waitForAppReady(fixture, 120_000)
    await openChat(page, CHAT_B)
    await openChat(page, CHAT_A)
    await expect.poll(() => runtimeByStoredId.has(DESTINATION_ID)).toBe(true)
    await openChat(page, CHAT_B)
    await expect.poll(() => runtimeByStoredId.has(SOURCE_ID)).toBe(true)
    const destinationHash = `#/${DESTINATION_ID}`
    const destinationRuntime = runtimeByStoredId.get(DESTINATION_ID)!
    const sourceRuntime = runtimeByStoredId.get(SOURCE_ID)!
    expect(sourceRuntime).not.toBe(destinationRuntime)

    await send(page, RUNNING)
    let inferenceHeld = false
    void mock.waitForHeldStream().then(() => { inferenceHeld = true })
    await expect.poll(() => inferenceHeld, { timeout: 45_000 }).toBe(true)
    await send(page, CORRECTION)
    await expect.poll(() => held, { timeout: 20_000 }).toBeTruthy()
    expect(fault?.params?.session_id).toBe(sourceRuntime)
    expect(held?.response.error).toBeUndefined()
    expect(held?.response.id).toBe(held?.request.id)
    expect(held?.response.result).toMatchObject({ session_id: sourceRuntime, resumed: SOURCE_ID, running: true })

    await openChat(page, CHAT_A)
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 30_000 }).toBe(destinationHash)
    await page.screenshot({ path: testInfo.outputPath('a-before-late-recovery.png') })
    releaseResume!()
    // The retry acknowledgement and completed source turn are causal barriers:
    // asserting A immediately after releasing the socket could pass too early.
    await expect.poll(() => retries.length, { timeout: 20_000 }).toBe(1)
    expect(retries[0].error).toBeUndefined()
    expect(['redirected', 'queued']).toContain(retries[0].result?.status)
    mock.releaseHeldStream()
    await expect.poll(() => completions.filter(r => r.params?.session_id === sourceRuntime && r.params?.payload?.status === 'complete').length, { timeout: 45_000 }).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 30_000 }).toBe(destinationHash)
    await expect(surface(page).locator('[data-slot="aui_thread-viewport"]')).toContainText(CHAT_A)
    await expect(surface(page).locator('[data-slot="aui_thread-viewport"]')).not.toContainText(CORRECTION)

    await send(page, MARKER)
    await expect.poll(() => markerOwners(fixture), { timeout: 30_000 }).toEqual([DESTINATION_ID])
    expect(requests.filter(r => r.method === 'prompt.submit' && r.params?.text === MARKER).map(r => r.params?.session_id)).toEqual([destinationRuntime])
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 30_000 }).toBe(destinationHash)
    await page.screenshot({ path: testInfo.outputPath('a-after-ordinary-send.png') })
  } finally {
    await testInfo.attach('recovery-boundaries', {
      body: JSON.stringify({ requests, fault, held, retries, completions, route: await page.evaluate(() => location.hash), owners: markerOwners(fixture) }, null, 2),
      contentType: 'application/json',
    })
  }
})
