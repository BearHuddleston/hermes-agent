// Regression based on andrexibiza’s PR #93508 review 5405545132.
// Real independent Chromium pages, ThemeProvider and native storage events; mocked config transport.
// Run from the repository root: CHROMIUM_PATH=/path/to/chrome node apps/desktop/scripts/smoke-appearance-pages.mjs
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

const repo = path.resolve(process.argv[2] || '.')
const require = createRequire(path.join(repo, 'apps/desktop/package.json'))
const {createServer} = await import(pathToFileURL(require.resolve('vite')).href)
const {chromium} = require('@playwright/test')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-appearance-'))
await fs.writeFile(path.join(root, 'index.html'), '<div id="root"></div><script type="module" src="/entry.tsx"></script>')
await fs.writeFile(path.join(root, 'entry.tsx'), `
import React from 'react'
import {createRoot} from 'react-dom/client'
document.documentElement.dataset.hermesDesktopHost = 'browser'
const profile = new URLSearchParams(location.search).get('profile') || 'default'
const held = []
Object.assign(window, {held, hermesDesktop: {api(request) {
  return request.method === 'PUT' ? new Promise(resolve => held.push({request, resolve})) : Promise.resolve({})
}}})
const {setApiRequestConnection, setApiRequestLocalMode, setApiRequestProfile} = await import('@/api/client')
const {$activeGatewayProfile} = await import('@/store/profile')
const {ThemeProvider, useTheme, skinPref, modePref} = await import('@/themes/context')
setApiRequestLocalMode(false); setApiRequestConnection('A'); setApiRequestProfile(profile)
$activeGatewayProfile.set(profile)
function Probe() {
  const theme = useTheme()
  Object.assign(window, {
    pick(field, value) { field === 'theme' ? theme.setTheme(value) : theme.setMode(value) },
    state(field) { return {view: field === 'theme' ? theme.themeName : theme.mode,
      cache: (field === 'theme' ? skinPref : modePref).own(profile),
      painted: document.documentElement.dataset.hermesTheme} },
    settle(ok) { const item = held.shift(); if (!item) throw Error('no pending PUT'); item.resolve({ok}); return item.request }
  })
  return <pre>{JSON.stringify({theme: theme.themeName, mode: theme.mode})}</pre>
}
createRoot(document.getElementById('root')).render(<ThemeProvider><Probe/></ThemeProvider>)
`)
// Vite reads port 0 as its default 5173, so concurrent runs would collide: take a free port instead.
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const {port} = probe.address()
    probe.close(() => resolve(port))
  })
})
const server = await createServer({
  configFile: path.join(repo, 'apps/desktop/vite.config.ts'), root,
  server: {host: '127.0.0.1', port, strictPort: true, fs: {allow: [repo, root]}}
})
let browser
const results = [], errors = []
try {
  await server.listen()
  browser = await chromium.launch({headless: true,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
    args: ['--disable-background-networking']})
  for (const profile of ['default', 'alpha']) for (const field of ['theme', 'theme_mode']) {
    const [base, first, second] = field === 'theme' ? ['ember', 'mono', 'everforest'] : ['light', 'dark', 'system']
    for (const scenario of ['peer-fail-A-B', 'peer-fail-B-A', 'single-both-fail', 'single-first-ok', 'peer-last-ok', 'peer-first-ok', 'peer-first-ok-late']) {
      const context = await browser.newContext()
      const a = await context.newPage()
      a.on('pageerror', e => errors.push(e.message))
      await a.addInitScript(profile => {
        localStorage.setItem('hermes-desktop-theme-v2', 'ember')
        localStorage.setItem('hermes-desktop-mode-v1', 'light')
        if (profile !== 'default') {
          localStorage.setItem('hermes-desktop-profile-themes-v1', JSON.stringify({[profile]: 'ember'}))
          localStorage.setItem('hermes-desktop-profile-modes-v1', JSON.stringify({[profile]: 'light'}))
        }
      }, profile)
      const open = async page => {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?profile=` + profile)
        await page.waitForFunction(() => typeof window.pick === 'function')
      }
      const state = page => page.evaluate(field => window.state(field), field)
      const wait = (page, value) => page.waitForFunction(({field,value}) => window.state(field).view === value, {field,value}, {timeout: 5000})
      const pick = (page,value) => page.evaluate(({field,value}) => window.pick(field,value), {field,value})
      let durable = base
      const settle = async (page,ok) => {
        await page.waitForFunction(() => window.held.length === 1)
        const request = await page.evaluate(ok => window.settle(ok), ok)
        if (request.connectionId !== 'A' || request.profile !== profile || request.path !== '/api/config') throw Error('wrong owner/endpoint')
        if (ok) durable = request.body.config.desktop[field]
      }
      await open(a)
      const b = scenario.startsWith('peer') ? await context.newPage() : a
      if (b !== a) { b.on('pageerror', e => errors.push(e.message)); await open(b) }
      await pick(a, first)
      await wait(b, first)
      await pick(b, second)
      await wait(a, second)
      if (scenario === 'peer-fail-B-A' || scenario === 'peer-first-ok-late') { await settle(b, false); await settle(a, scenario === 'peer-first-ok-late') }
      else { await settle(a, (scenario === 'single-first-ok' || scenario === 'peer-first-ok')); await settle(b, scenario === 'peer-last-ok') }
      await a.waitForFunction(() => window.held.length === 0)
      await b.waitForFunction(() => window.held.length === 0)
      await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      if (b !== a) await b.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const expected = durable
      await Promise.all([wait(a, expected), wait(b, expected)]).catch(() => undefined)
      const states = [await state(a), await state(b)]
      const pass = states.every(s => s.view === durable && s.cache === durable && (field !== 'theme' || s.painted === durable))
      results.push({profile, field, scenario, durable, states, pass})
      console.log(JSON.stringify(results.at(-1)))
      await context.close()
    }
  }
  const receipt = {results, errors, failed: results.filter(r => !r.pass).length, passed: results.filter(r => r.pass).length}
  await fs.writeFile(process.env.HERMES_APPEARANCE_RECEIPT || path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log('SUMMARY', JSON.stringify({failed: receipt.failed, passed: receipt.passed, errors}))
  if (receipt.failed || errors.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  await fs.rm(root, {recursive: true, force: true})
}
