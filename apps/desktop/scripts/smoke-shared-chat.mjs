#!/usr/bin/env node
/**
 * Two-person smoke for a shared Webapp chat (presence + turn ownership).
 *
 * Starts, all on loopback and in a throwaway HOME:
 *  - a Nous Portal stand-in: authorization code + PKCE, RS256 JWTs, two test
 *    accounts, the claims plugins/dashboard_auth/nous verifies;
 *  - a scripted OpenAI-compatible model ("clean" in the prompt -> one terminal
 *    call that needs approval);
 *  - `hermes webapp --skip-build` with the sign-in gate on and manual approvals.
 * Then signs in as Alice and Bob in two browser contexts and checks, through the
 * DOM, that only the person who sent a turn can answer its approval, that the
 * other person's message queues behind it, that both windows show the prompts in
 * order with sender labels, and that presence (roster, pointer, typing) works.
 *
 * Needs `npm run build:webapp` first. Python: HERMES_PYTHON, else the
 * checkout's .venv. HEADED=1 shows the browsers. Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(DESKTOP, '../..')
const PYTHON = process.env.HERMES_PYTHON || path.join(ROOT, '.venv', 'bin', 'python')
const HOST = 'hermes-shared-chat.test'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!fs.existsSync(path.join(DESKTOP, 'dist-webapp', 'index.html'))) {
  console.error('dist-webapp is missing: run `npm run build:webapp` first')
  process.exit(2)
}

// ---- helpers ---------------------------------------------------------------

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return { port: server.address().port, server }
}

async function freePort() {
  const { port, server } = await listen(() => {})
  await new Promise(resolve => server.close(resolve))

  return port
}

const readBody = req =>
  new Promise(resolve => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => resolve(data))
  })

const b64url = buffer => Buffer.from(buffer).toString('base64url')

// ---- Nous Portal stand-in --------------------------------------------------

const ACCOUNTS = { 'alice@example.test': 'usr_alice_smoke', 'bob@example.test': 'usr_bob_smoke' }

async function startPortal() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'smoke', use: 'sig' }
  const codes = new Map()
  let issuer = ''

  const sign = claims => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'smoke', typ: 'JWT' }))
    const body = b64url(JSON.stringify(claims))

    return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`
  }

  const tokens = (sub, clientId) => {
    const now = Math.floor(Date.now() / 1000)

    return {
      access_token: sign({
        agent_instance_id: clientId.split(':')[1],
        aud: clientId,
        exp: now + 3600,
        iat: now,
        iss: issuer,
        oauth_contract_version: 1,
        scope: 'agent_dashboard:access',
        sub
      }),
      expires_in: 3600,
      token_type: 'Bearer'
    }
  }

  const { port, server } = await listen(async (req, res) => {
    const url = new URL(req.url, issuer)
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    if (url.pathname === '/.well-known/jwks.json') {
      return send(200, { keys: [jwk] })
    }

    if (url.pathname === '/oauth/authorize') {
      const q = Object.fromEntries(url.searchParams)

      if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
        return send(400, { error: 'invalid_request' })
      }

      const links = Object.entries(ACCOUNTS).map(([email, sub]) => {
        const code = crypto.randomBytes(18).toString('base64url')
        codes.set(code, { challenge: q.code_challenge, clientId: q.client_id, redirectUri: q.redirect_uri, sub })
        const target = `${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`

        return `<a data-account="${email}" href="${target.replaceAll('&', '&amp;')}">Continue as ${email}</a>`
      })

      return send(200, `<!doctype html><title>Portal stand-in</title>${links.join('<br>')}`, 'text/html')
    }

    if (url.pathname === '/api/oauth/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      const entry = codes.get(form.code)
      codes.delete(form.code)
      const digest = crypto
        .createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url')

      if (
        !entry ||
        digest !== entry.challenge ||
        form.redirect_uri !== entry.redirectUri ||
        form.client_id !== entry.clientId
      ) {
        return send(400, { error: 'invalid_grant' })
      }

      return send(200, tokens(entry.sub, entry.clientId))
    }

    send(404, {})
  })

  issuer = `http://127.0.0.1:${port}`

  return { server, url: issuer }
}

// ---- scripted model --------------------------------------------------------

const REPLIES = [
  ['launch', 'Here is a launch checklist for Friday. Want me to draft the changelog next?'],
  ['changelog', 'Draft changelog: shared chats, presence and turn ownership. It fits the announcement post.'],
  ['', 'Noted.']
]

async function startModel() {
  const { port, server } = await listen(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })

      return res.end(JSON.stringify({ data: [{ id: 'smoke-model', object: 'model' }], object: 'list' }))
    }

    const body = JSON.parse((await readBody(req)) || '{}')
    const messages = body.messages ?? []
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const prompt = (
      typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    ).toLowerCase()
    const afterTool = messages.at(-1)?.role === 'tool'
    const chunk = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish, index: 0 }], created: 0, id: 'x', model: 'smoke-model', object: 'chat.completion.chunk' })}\n\n`
      )

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })

      return res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', index: 0, message: { content: 'Shared chat', role: 'assistant' } }],
          id: 'x',
          object: 'chat.completion'
        })
      )
    }

    res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream' })
    chunk({ content: '', role: 'assistant' })

    if (!afterTool && prompt.includes('clean')) {
      chunk({ content: 'Clearing the old build output first.' })
      chunk({
        tool_calls: [
          {
            function: { arguments: JSON.stringify({ command: 'rm -rf tmp-build-output' }), name: 'terminal' },
            id: `call_${Date.now()}`,
            index: 0,
            type: 'function'
          }
        ]
      })
      chunk({}, 'tool_calls')
    } else {
      const text = afterTool
        ? 'Cleanup finished; the next build starts from a clean tree.'
        : REPLIES.find(([key]) => prompt.includes(key))[1]

      for (const word of text.split(/(?<= )/)) {
        chunk({ content: word })
        await sleep(15)
      }

      chunk({}, 'stop')
    }

    res.end('data: [DONE]\n\n')
  })

  return { server, url: `http://127.0.0.1:${port}/v1` }
}

// ---- Hermes Webapp ---------------------------------------------------------

async function startWebapp(home, portalUrl, modelUrl) {
  const port = await freePort()
  const hermesHome = path.join(home, '.hermes')
  const repo = path.join(home, 'repo')
  fs.mkdirSync(path.join(repo, 'tmp-build-output'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'tmp-build-output', 'app.js'), '// stale build output\n')
  fs.mkdirSync(hermesHome, { recursive: true })
  fs.writeFileSync(
    path.join(hermesHome, 'config.yaml'),
    [
      'model:',
      '  default: smoke-model',
      '  provider: custom',
      `  base_url: ${modelUrl}`,
      '  context_length: 64000',
      'approvals:',
      '  mode: manual',
      'terminal:',
      `  cwd: ${repo}`,
      'dashboard:',
      `  public_url: http://${HOST}:${port}`,
      '  oauth:',
      '    client_id: agent:shared-chat-smoke',
      `    portal_url: ${portalUrl}`,
      'telemetry:',
      '  shared_metrics: {enabled: false, send: false}',
      'onboarding:',
      '  seen: {profile_build_offered: true}',
      ''
    ].join('\n')
  )
  // A placeholder key for the scripted local model; not a credential.
  fs.writeFileSync(path.join(hermesHome, '.env'), 'OPENAI_API_KEY=smoke-placeholder\n', { mode: 0o600 })

  const child = spawn(
    PYTHON,
    ['-m', 'hermes_cli.main', 'webapp', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--skip-build'],
    {
      cwd: repo,
      env: {
        HERMES_HOME: hermesHome,
        HOME: home,
        LANG: 'C.UTF-8',
        PATH: process.env.PATH,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: ROOT,
        PYTHONUNBUFFERED: '1',
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let log = ''
  const ready = new Promise((resolve, reject) => {
    const onData = chunk => {
      log += chunk
      if (log.includes('HERMES_DASHBOARD_READY')) resolve()
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => reject(new Error(`webapp exited (${code})\n${log.slice(-2000)}`)))
  })

  await Promise.race([
    ready,
    sleep(120_000).then(() => Promise.reject(new Error(`webapp not ready\n${log.slice(-2000)}`)))
  ])

  return { child, log: () => log, origin: `http://${HOST}:${port}`, port, repo }
}

// ---- the two people --------------------------------------------------------

const checks = []

function check(name, ok, detail) {
  checks.push({ detail, name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
}

async function waitFor(read, pred, ms = 20_000) {
  const end = Date.now() + ms
  let value = await read()

  while (!pred(value) && Date.now() < end) {
    await sleep(150)
    value = await read()
  }

  return value
}

async function person(browser, origin, email) {
  const context = await browser.newContext({
    colorScheme: 'dark',
    locale: 'en-US',
    viewport: { height: 1000, width: 960 }
  })
  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await page.click(`a[data-account="${email}"]`, { timeout: 30_000 })
  await page.waitForSelector('[contenteditable="true"]', { timeout: 60_000 })
  await sleep(2000)

  for (const name of ['No thanks', 'Skip', 'Not now']) {
    await page
      .getByRole('button', { name })
      .first()
      .click({ timeout: 500 })
      .catch(() => {})
  }

  return { context, page }
}

const thread = page => page.evaluate(() => document.querySelector('[data-slot="aui_thread-viewport"]')?.innerText ?? '')

const approval = page =>
  page.evaluate(() => {
    const card = document.querySelector('[data-slot="tool-approval-card"]')

    return card
      ? {
          run: Boolean(card.querySelector('[data-approval-run]')),
          waiting: card.querySelector('[data-slot="shared-turn-waiting"]')?.textContent ?? null
        }
      : null
  })

async function send(page, text) {
  await page.locator('[contenteditable="true"]').first().click()
  await page.keyboard.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

async function rename(page, name) {
  await page.click('[data-slot="presence-self"]')
  await page.fill('#presence-name', name)
  await page.keyboard.press('Enter')
}

async function scenario(origin, repo, alice, bob) {
  await send(alice, 'Plan the launch for Friday')
  await waitFor(
    () => thread(alice),
    text => text.includes('changelog next'),
    30_000
  )
  await bob.goto(alice.url())
  await waitFor(
    () => thread(bob),
    text => text.includes('changelog next'),
    30_000
  )
  await rename(alice, 'Alice')
  await rename(bob, 'Bob')

  const roster = await waitFor(
    () =>
      alice.evaluate(() =>
        [...document.querySelectorAll('[data-presence-user]')].map(e => e.getAttribute('data-presence-user'))
      ),
    users => users.length === 1,
    10_000
  )
  check('roster lists the other person', roster.length === 1 && roster[0].endsWith('usr_bob_smoke'), roster)

  const box = await bob.locator('[data-slot="aui_message-group"]').last().boundingBox()
  await bob.mouse.move(box.x + 40, box.y + 20)
  await bob.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 10 })
  const pointer = await waitFor(
    () => alice.evaluate(() => document.querySelector('[data-presence-cursor]')?.textContent ?? null),
    label => label === 'Bob',
    8000
  )
  check("each window shows the other person's named pointer", pointer === 'Bob', pointer)

  await bob.locator('[contenteditable="true"]').first().click()
  await bob.keyboard.type('Then draft', { delay: 20 })
  const typing = await waitFor(
    () => alice.evaluate(() => document.querySelector('[data-slot="presence-typing"]')?.textContent ?? ''),
    text => text.includes('Bob'),
    8000
  )
  check('"Bob is typing" reaches Alice', typing.includes('Bob is typing'), typing)
  await bob.keyboard.press('Control+A')
  await bob.keyboard.press('Delete')

  await send(alice, 'Now clean the build output')
  const ownerCard = await waitFor(
    () => approval(alice),
    card => card?.run,
    30_000
  )
  const peerCard = await waitFor(
    () => approval(bob),
    card => card?.waiting,
    15_000
  )
  check('the sender can answer the approval', Boolean(ownerCard?.run) && !ownerCard?.waiting, ownerCard)
  check(
    "the other person sees it read-only, with the sender's name",
    Boolean(peerCard) && !peerCard.run && /Alice/.test(peerCard.waiting ?? ''),
    peerCard
  )

  const placeholder = await bob.evaluate(
    () => document.querySelector('[contenteditable="true"]')?.getAttribute('data-placeholder') ?? ''
  )
  check("the other person's composer says whose turn is running", /Alice/.test(placeholder), placeholder)

  await send(bob, 'Then draft the changelog')
  await sleep(1500)
  check(
    'a message from the other person does not interrupt the turn',
    Boolean((await approval(alice))?.run) && fs.existsSync(path.join(repo, 'tmp-build-output')),
    await approval(alice)
  )

  await alice.click('[data-approval-run]')
  const prompts = ['Now clean the build output', 'Then draft the changelog']
  const order = text =>
    prompts
      .map(p => [p, text.indexOf(p)])
      .filter(([, i]) => i >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([p]) => p)
  const aliceText = await waitFor(
    () => thread(alice),
    text => text.includes('announcement post'),
    45_000
  )
  const bobText = await waitFor(
    () => thread(bob),
    text => text.includes('announcement post'),
    20_000
  )
  check(
    'the queued message runs after the turn, in order in both windows',
    order(aliceText).join('|') === prompts.join('|') &&
      order(bobText).join('|') === prompts.join('|') &&
      aliceText.indexOf('clean tree') < aliceText.indexOf('announcement post') &&
      !fs.existsSync(path.join(repo, 'tmp-build-output')),
    { alice: order(aliceText), bob: order(bobText) }
  )

  const labels = page =>
    page.evaluate(() => [...document.querySelectorAll('[data-message-sender]')].map(e => e.textContent))
  const aliceLabels = await waitFor(
    () => labels(alice),
    names => names.includes('Bob'),
    10_000
  )
  const bobLabels = await waitFor(
    () => labels(bob),
    names => names.includes('Alice'),
    10_000
  )
  check(
    "each window labels the other person's messages, not its own",
    aliceLabels.includes('Bob') &&
      !aliceLabels.includes('Alice') &&
      bobLabels.includes('Alice') &&
      !bobLabels.includes('Bob'),
    { alice: aliceLabels, bob: bobLabels }
  )
}

// ---- run -------------------------------------------------------------------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shared-chat-'))
const portal = await startPortal()
const model = await startModel()
let webapp
let browser

try {
  webapp = await startWebapp(home, portal.url, model.url)
  browser = await chromium.launch({
    args: [
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${webapp.origin}`
    ],
    headless: process.env.HEADED !== '1'
  })
  const [alice, bob] = await Promise.all([
    person(browser, webapp.origin, 'alice@example.test'),
    person(browser, webapp.origin, 'bob@example.test')
  ])
  await scenario(webapp.origin, webapp.repo, alice.page, bob.page)
} catch (error) {
  check('scenario ran to completion', false, String(error?.stack ?? error))
} finally {
  await browser?.close()
  webapp?.child.kill('SIGTERM')
  portal.server.close()
  model.server.close()
  await sleep(500)
  fs.rmSync(home, { force: true, recursive: true })
}

const failed = checks.filter(c => !c.ok).length
console.log(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
