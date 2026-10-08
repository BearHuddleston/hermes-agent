import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import {
  claimAgent,
  type KnownPerson,
  listPeople,
  setChatAccess,
  type ShareRole,
  sharingErrorDetail,
  type SharingPerson
} from '@/api/sharing'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { $chatAccess, $sharingMe, refreshChatAccess, refreshSharingMe } from '@/store/sharing'

const ACCOUNT_ID_RE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._@|+-]{0,127}$/

function splitRoom(room: string): { profile: string; sessionId: string } {
  const separator = room.indexOf(':')

  return { profile: room.slice(0, separator), sessionId: room.slice(separator + 1) }
}

function Person({ person, children }: { person: SharingPerson; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 py-1.5" data-share-person={person.principal}>
      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: person.color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-(--ui-text-primary)">{person.name}</span>
        <span className="block truncate font-mono text-[0.6875rem] text-(--ui-text-tertiary)">{person.principal}</span>
      </span>
      {children}
    </li>
  )
}

/** The Share button beside the presence roster, and the dialog it opens. */
export function ShareButton({ room }: { room: string }) {
  const { t } = useI18n()
  const me = useStore($sharingMe)
  const [open, setOpen] = useState(false)

  if (!me?.principal) {
    return null // loopback / token windows have no account to share with
  }

  return (
    <>
      <Button
        className="pointer-events-auto h-8 gap-1.5 rounded-full px-3 shadow-sm"
        data-slot="share-chat"
        onClick={() => setOpen(true)}
        size="sm"
        variant="floating"
      >
        <Codicon name="person-add" size="0.9rem" />
        {t.sharing.share}
      </Button>
      {open && <ShareDialog onOpenChange={setOpen} room={room} />}
    </>
  )
}

function ShareDialog({ onOpenChange, room }: { onOpenChange: (open: boolean) => void; room: string }) {
  const { t } = useI18n()
  const s = t.sharing
  const me = useStore($sharingMe)
  const access = useStore($chatAccess)[room] ?? null
  const [people, setPeople] = useState<KnownPerson[] | null>(null)
  const [draft, setDraft] = useState('')
  const [draftRole, setDraftRole] = useState<ShareRole>('viewer')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const { profile, sessionId } = splitRoom(room)

  const loadPeople = () =>
    void listPeople()
      .then(result => setPeople(result.people))
      .catch(() => setPeople([]))

  const reload = async () => {
    const [nextMe, nextAccess] = await Promise.all([refreshSharingMe(), refreshChatAccess(room)])

    if (nextMe?.owner && nextAccess?.can_share) {
      loadPeople()
    }
  }

  const change = async (principal: string, role: null | ShareRole) => {
    setBusy(true)

    try {
      await setChatAccess(sessionId, profile, principal, role)
      await reload()

      return true
    } catch (error) {
      notifyError(new Error(sharingErrorDetail(error)), s.changeFailed)

      return false
    } finally {
      setBusy(false)
    }
  }

  const claim = async () => {
    setBusy(true)

    try {
      await claimAgent()
      await reload()
    } catch (error) {
      notifyError(new Error(sharingErrorDetail(error)), s.claimFailed)
    } finally {
      setBusy(false)
    }
  }

  const copyId = async () => {
    if (me?.principal) {
      await navigator.clipboard.writeText(me.principal).catch(() => undefined)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  // On open: who we are, this chat's list and (for its owner) everyone who signed in.
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open; reload reads the room it was opened for
  }, [room])

  const shared = new Set(access?.people.map(person => person.principal) ?? [])

  const candidates = (people ?? []).filter(
    person => person.principal !== me?.principal && person.principal !== access?.creator?.principal && !shared.has(person.principal)
  )

  const draftValid = ACCOUNT_ID_RE.test(draft.trim())

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-md" data-slot="share-dialog">
        <DialogHeader>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription>{s.description}</DialogDescription>
        </DialogHeader>

        {me?.can_claim && (
          <section className="rounded-md border border-(--ui-stroke-secondary) p-3" data-slot="share-claim">
            <h3 className="text-sm font-medium text-(--ui-text-primary)">{s.claimTitle}</h3>
            <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{s.claimBody}</p>
            <Button className="mt-2" disabled={busy} onClick={() => void claim()} size="sm">
              {s.claim}
            </Button>
          </section>
        )}

        {access?.can_share && me?.sharing && (
          <section className="flex flex-col gap-2" data-slot="share-add">
            <label className="text-xs font-medium text-(--ui-text-secondary)" htmlFor="share-account-id">
              {s.addPerson}
            </label>
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (draftValid) {
                  void change(draft.trim(), draftRole).then(ok => ok && setDraft(''))
                }
              }}
            >
              <Input
                className="flex-1 font-mono text-xs"
                id="share-account-id"
                onChange={event => setDraft(event.target.value)}
                placeholder={s.addPlaceholder}
                value={draft}
              />
              <RoleSelect onChange={setDraftRole} value={draftRole} />
              <Button disabled={busy || !draftValid} size="sm" type="submit">
                {s.add}
              </Button>
            </form>
            <div>
              <h3 className="text-xs font-medium text-(--ui-text-secondary)">{s.signedInRecently}</h3>
              {candidates.length === 0 ? (
                <p className="py-1.5 text-xs text-(--ui-text-tertiary)">{s.nobodyYet}</p>
              ) : (
                <ul className="divide-y divide-(--ui-stroke-tertiary)" data-slot="share-candidates">
                  {candidates.map(person => (
                    <Person key={person.principal} person={person}>
                      <Button
                        disabled={busy}
                        onClick={() => void change(person.principal, draftRole)}
                        size="xs"
                        variant="outline"
                      >
                        {s.add}
                      </Button>
                    </Person>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {access && (
          <section data-slot="share-members">
            <h3 className="text-xs font-medium text-(--ui-text-secondary)">{s.sharedWith}</h3>
            <ul className="divide-y divide-(--ui-stroke-tertiary)">
              {access.creator && (
                <Person person={access.creator}>
                  <span className="text-xs text-(--ui-text-tertiary)">{s.roleOwner}</span>
                </Person>
              )}
              {access.people.map(person => (
                <Person key={person.principal} person={person}>
                  {access.can_share ? (
                    <>
                      <RoleSelect
                        disabled={busy}
                        onChange={role => void change(person.principal, role)}
                        value={person.role}
                      />
                      <Button
                        aria-label={s.remove}
                        disabled={busy}
                        onClick={() => void change(person.principal, null)}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <Codicon name="close" size="0.85rem" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-(--ui-text-tertiary)">
                      {person.role === 'participant' ? s.roleParticipant : s.roleViewer}
                    </span>
                  )}
                </Person>
              ))}
            </ul>
            {access.people.length === 0 && <p className="py-1.5 text-xs text-(--ui-text-tertiary)">{s.notShared}</p>}
          </section>
        )}

        {me?.principal && (
          <section className="rounded-md bg-(--ui-bg-tertiary) p-3" data-slot="share-my-id">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-(--ui-text-secondary)">{s.yourId}</span>
              <Button onClick={() => void copyId()} size="xs" variant="outline">
                {copied ? s.copied : s.copy}
              </Button>
            </div>
            <code className="mt-1 block select-all break-all font-mono text-xs text-(--ui-text-primary)">{me.principal}</code>
            <p className="mt-1 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{s.yourIdHint}</p>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RoleSelect({
  disabled,
  onChange,
  value
}: {
  disabled?: boolean
  onChange: (role: ShareRole) => void
  value: ShareRole
}) {
  const { t } = useI18n()

  return (
    <Select disabled={disabled} onValueChange={next => onChange(next as ShareRole)} value={value}>
      <SelectTrigger className="h-8 w-32 rounded-md text-xs" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="viewer">{t.sharing.roleViewer}</SelectItem>
        <SelectItem value="participant">{t.sharing.roleParticipant}</SelectItem>
      </SelectContent>
    </Select>
  )
}
