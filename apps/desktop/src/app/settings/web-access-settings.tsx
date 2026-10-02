import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useEffect, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  getActionStatus,
  getWebAccessStatus,
  listOAuthProviders,
  removeWebAccessNous,
  removeWebAccessPassword,
  setUpWebAccessNous,
  setWebAccessPassword,
  startWebAccess,
  stopWebAccess,
  type WebAccessMode,
  type WebAccessPlan,
  type WebAccessStatus
} from '@/hermes'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/external-link'
import { Globe, Loader2, Network, Play, ShieldLock, StopFilled } from '@/lib/icons'
import { isBrowserHostedDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { $connection } from '@/store/session'

import { CONTROL_TEXT } from './constants'
import {
  EmptyState,
  ListRow,
  Pill,
  SectionHeading,
  SettingsContent,
  SettingsSection,
  SettingsSkeleton
} from './primitives'
import { ActiveProfileNote } from './profile-scope'

// Bounded wait for a spawned web app to show up as running (renderer build +
// server bind), then the action's own exit decides "failed".
const START_POLL_MS = 1500
const START_TIMEOUT_MS = 90_000

type Busy = 'nous' | 'password' | 'start' | 'stop' | null

function webAccessKey(scope: string): readonly unknown[] {
  return ['web-access', scope]
}

/** Poll until this home's web app is serving, its spawn exits, or time runs out. */
async function waitForWebApp(action: string): Promise<'failed' | 'running' | 'timeout'> {
  const deadline = Date.now() + START_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, START_POLL_MS))

    if ((await getWebAccessStatus()).running.length > 0) {
      return 'running'
    }

    const spawn = await getActionStatus(action, 1)

    if (!spawn.running && spawn.exit_code !== null) {
      return 'failed'
    }
  }

  return 'timeout'
}

async function renderQr(payload: string): Promise<string> {
  // Lazy: the encoder only loads while a LAN address is on screen.
  const QRCode = await import('qrcode')

  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 176 })
}

function useQrCode(payload: null | string): null | string {
  const [image, setImage] = useState<null | string>(null)

  useEffect(() => {
    let current = true
    setImage(null)

    if (payload) {
      void renderQr(payload).then(url => current && setImage(url))
    }

    return () => {
      current = false
    }
  }, [payload])

  return image
}

/** Web access serves THIS machine: the native app on its local connection only. */
export function useWebAccessAvailable(): boolean {
  const connection = useStore($connection)

  return !isBrowserHostedDesktop() && connection?.mode !== 'remote'
}

export function WebAccessSettings(): ReactElement {
  const { t } = useI18n()
  const w = t.settings.webAccess

  if (!useWebAccessAvailable()) {
    return (
      <SettingsContent>
        <EmptyState description={w.unavailableDesc} title={w.unavailableTitle} />
      </SettingsContent>
    )
  }

  return <AvailableWebAccessSettings />
}

function AvailableWebAccessSettings(): ReactElement {
  const { t } = useI18n()
  const w = t.settings.webAccess
  const scope = JSON.stringify(useStore($apiRequestScope))
  const queryClient = useQueryClient()
  const key = webAccessKey(scope)
  const { data: status, error } = useQuery({ queryFn: getWebAccessStatus, queryKey: key, retry: false })

  // Nous sign-in registers this computer under the user's own Nous account, so
  // it needs one signed in (a free-tier identity has no account to register under).
  const { data: oauth } = useQuery({
    queryFn: () => listOAuthProviders(),
    queryKey: [...key, 'nous-account'],
    retry: false
  })

  const nousAccount = oauth?.providers.find(provider => provider.id === 'nous')?.status
  const nousSignedIn = Boolean(nousAccount?.logged_in && !nousAccount.free_tier)
  const [busy, setBusy] = useState<Busy>(null)
  const [mode, setMode] = useState<WebAccessMode | null>(null)
  const [publicUrl, setPublicUrl] = useState<null | string>(null)
  const [port, setPort] = useState<null | string>(null)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')

  const server = status?.running[0] ?? null
  const qr = useQrCode(server?.mode === 'lan' && status?.lan_address ? `http://${status.lan_address}:${server.port}` : null)

  if (error) {
    return (
      <SettingsContent>
        <p className="text-[0.75rem] text-destructive">{w.loadFailed}</p>
      </SettingsContent>
    )
  }

  if (!status) {
    return <SettingsSkeleton sections={[{ rows: 1 }, { rows: 2 }, { rows: 2 }]} />
  }

  // Server truth seeds the form; the user's edits win until they apply them.
  const chosenMode: WebAccessMode = mode ?? (server?.mode === 'public' || (!server && status.public_url) ? 'public' : 'lan')
  const chosenUrl = publicUrl ?? status.public_url
  const chosenPort = port ?? String(server?.port ?? status.default_port)
  const hasSignIn = Boolean(status.nous_client_id || status.password_username)

  const plan: WebAccessPlan = {
    mode: chosenMode,
    port: Number(chosenPort) || status.default_port,
    ...(chosenMode === 'public' ? { public_url: chosenUrl.trim() } : {})
  }

  const planReady = chosenMode === 'lan' ? Boolean(status.lan_address) : chosenUrl.trim().startsWith('https://')
  const lanUrl = status.lan_address ? `http://${status.lan_address}:${plan.port}` : null

  const openUrl = server
    ? server.mode === 'lan' && status.lan_address
      ? `http://${status.lan_address}:${server.port}`
      : server.mode === 'public'
        ? status.public_url
        : `http://127.0.0.1:${server.port}`
    : null

  function apply(next: WebAccessStatus): void {
    queryClient.setQueryData(key, next)
  }

  async function run(kind: Exclude<Busy, null>, fallback: string, work: () => Promise<void>): Promise<void> {
    setBusy(kind)

    try {
      await work()
    } catch (err) {
      notifyError(err, fallback)
    } finally {
      setBusy(null)
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  const start = () =>
    run('start', w.startFailed, async () => {
      const { name } = await startWebAccess(plan)
      const outcome = await waitForWebApp(name)

      if (outcome !== 'running') {
        throw new Error(outcome === 'failed' ? w.startExited : w.startTimedOut)
      }
    })

  const stop = () => run('stop', w.stopFailed, async () => void (await stopWebAccess()))

  const setUpNous = () => run('nous', w.nousFailed, async () => apply(await setUpWebAccessNous(plan)))

  const removeNous = () => run('nous', w.removeFailed, async () => apply(await removeWebAccessNous()))

  const savePassword = () =>
    run('password', w.passwordFailed, async () => {
      apply(await setWebAccessPassword(username, password))
      setPassword('')
    })

  const removePassword = () => run('password', w.removeFailed, async () => apply(await removeWebAccessPassword()))

  const spinning = (kind: Busy) => cn(busy === kind && '[&_svg]:animate-spin')

  return (
    <SettingsContent>
      <ActiveProfileNote className="mb-5" />
      <SectionHeading icon={Network} page title={w.title} />
      <p className="mb-4 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {w.intro} {w.warning}
      </p>

      <SettingsSection
        aside={<Pill tone={server ? 'success' : 'muted'}>{server ? w.running : w.stopped}</Pill>}
        icon={Globe}
        title={w.statusTitle}
      >
        {server && openUrl ? (
          <ListRow
            action={
              <>
                <CopyButton appearance="icon" buttonSize="sm" buttonVariant="outline" text={openUrl} />
                <Button className={spinning('stop')} disabled={busy !== null} onClick={() => void stop()} size="sm" variant="outline">
                  {busy === 'stop' ? <Loader2 /> : <StopFilled />}
                  {w.stop}
                </Button>
              </>
            }
            below={
              qr ? (
                <div className="mt-3 flex items-center gap-3">
                  <img alt={w.scanToOpen} className="size-28 rounded-md bg-white p-1" src={qr} />
                  <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {w.scanToOpen}
                  </span>
                </div>
              ) : undefined
            }
            description={
              server.mode === 'lan' ? w.runningLan : server.mode === 'public' ? w.runningPublic(server.port) : w.runningLocal
            }
            title={<ExternalLink href={openUrl}>{openUrl}</ExternalLink>}
          />
        ) : (
          <ListRow
            action={
              <Button
                className={spinning('start')}
                disabled={busy !== null || !hasSignIn || !planReady}
                onClick={() => void start()}
                size="sm"
              >
                {busy === 'start' ? <Loader2 /> : <Play />}
                {busy === 'start' ? w.starting : w.start}
              </Button>
            }
            description={hasSignIn ? w.notRunningDetail : w.needsSignIn}
            title={w.notRunning}
          />
        )}
      </SettingsSection>

      <SettingsSection icon={Globe} title={w.whereTitle}>
        <ListRow
          action={
            <SegmentedControl
              disabled={Boolean(server) || busy !== null}
              onChange={setMode}
              options={[
                { id: 'lan', label: w.modeLan },
                { id: 'public', label: w.modePublic }
              ]}
              value={chosenMode}
            />
          }
          description={
            server
              ? w.lockedWhileRunning
              : chosenMode === 'lan'
                ? lanUrl
                  ? w.modeLanDetail(lanUrl)
                  : w.noLan
                : w.modePublicDetail(plan.port)
          }
          title={chosenMode === 'lan' ? w.modeLan : w.modePublic}
        />
        {chosenMode === 'public' && (
          <ListRow
            action={
              <Input
                className={CONTROL_TEXT}
                disabled={Boolean(server)}
                onChange={event => setPublicUrl(event.target.value)}
                placeholder={w.publicUrlPlaceholder}
                value={chosenUrl}
              />
            }
            title={w.publicUrlLabel}
          />
        )}
        <ListRow
          action={
            <Input
              className={CONTROL_TEXT}
              disabled={Boolean(server)}
              inputMode="numeric"
              onChange={event => setPort(event.target.value.replace(/\D/g, ''))}
              value={chosenPort}
            />
          }
          title={w.portLabel}
        />
      </SettingsSection>

      <SettingsSection icon={ShieldLock} title={w.signInTitle}>
        <ListRow
          action={
            status.nous_client_id ? (
              <Button className={spinning('nous')} disabled={busy !== null} onClick={() => void removeNous()} size="sm" variant="outline">
                {w.remove}
              </Button>
            ) : (
              <Button
                className={spinning('nous')}
                disabled={busy !== null || !planReady || !nousSignedIn}
                onClick={() => void setUpNous()}
                size="sm"
              >
                {busy === 'nous' && <Loader2 />}
                {w.setUp}
              </Button>
            )
          }
          description={status.nous_client_id ? w.nousOn : nousSignedIn ? w.nousOff : w.nousNeedsAccount}
          title={w.nousTitle}
        />
        <ListRow
          action={
            status.password_username ? (
              <Button
                className={spinning('password')}
                disabled={busy !== null}
                onClick={() => void removePassword()}
                size="sm"
                variant="outline"
              >
                {w.remove}
              </Button>
            ) : undefined
          }
          below={
            status.password_username ? undefined : (
              <div className="mt-3 grid max-w-sm gap-2">
                <Input
                  aria-label={w.username}
                  className={CONTROL_TEXT}
                  onChange={event => setUsername(event.target.value)}
                  placeholder={w.username}
                  value={username}
                />
                <Input
                  aria-label={w.password}
                  className={CONTROL_TEXT}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={w.password}
                  type="password"
                  value={password}
                />
                <div>
                  <Button
                    className={spinning('password')}
                    disabled={busy !== null || !username.trim() || !password}
                    onClick={() => void savePassword()}
                    size="sm"
                    variant="outline"
                  >
                    {busy === 'password' && <Loader2 />}
                    {w.save}
                  </Button>
                </div>
              </div>
            )
          }
          description={
            status.password_username
              ? chosenMode === 'public'
                ? w.passwordPublicWarning
                : w.passwordOn(status.password_username)
              : w.passwordOff
          }
          title={w.passwordTitle}
        />
      </SettingsSection>
    </SettingsContent>
  )
}
