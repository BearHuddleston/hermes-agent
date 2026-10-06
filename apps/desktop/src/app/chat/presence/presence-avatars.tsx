import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { presenceRename } from '@/lib/presence-client'
import { cn } from '@/lib/utils'
import { $presencePeers, $presenceSelf, presenceUsers } from '@/store/presence'

const MAX_SHOWN = 4

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)

  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

function Avatar({ color, name, ring }: { color: string; name: string; ring?: boolean }) {
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold text-white ring-2 ring-(--ui-chat-surface-background)',
        ring && 'outline-1 outline-offset-1 outline-(--ui-stroke-secondary)'
      )}
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </span>
  )
}

/** Who else is in this chat, plus this window's own chip (click to change your name). */
export function PresenceAvatars() {
  const { t } = useI18n()
  const self = useStore($presenceSelf)
  const users = presenceUsers(useStore($presencePeers)).filter(user => user.user !== self?.user)

  if (!self) {
    return null
  }

  const shown = users.slice(0, MAX_SHOWN)
  const hidden = users.length - shown.length

  return (
    <div
      className="pointer-events-auto flex shrink-0 items-center -space-x-1.5 rounded-full bg-(--ui-chat-surface-background)/80 p-1 shadow-sm backdrop-blur-sm"
      data-slot="presence-avatars"
    >
      {shown.map(user => (
        <Tip key={user.user} label={`${user.name} · ${user.label}${user.windows > 1 ? ` · ${t.presence.windows(user.windows)}` : ''}`}>
          <span data-presence-user={user.user}>
            <Avatar color={user.color} name={user.name} />
          </span>
        </Tip>
      ))}
      {hidden > 0 && (
        <span className="grid size-6 place-items-center rounded-full bg-(--ui-bg-tertiary) text-[0.625rem] font-semibold text-(--ui-text-secondary) ring-2 ring-(--ui-chat-surface-background)">
          +{hidden}
        </span>
      )}
      <SelfChip />
    </div>
  )
}

function SelfChip() {
  const { t } = useI18n()
  const self = useStore($presenceSelf)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  if (!self) {
    return null
  }

  const save = () => {
    presenceRename(draft)
    setOpen(false)
  }

  return (
    <Popover
      onOpenChange={next => {
        setOpen(next)

        if (next) {
          setDraft(self.name)
        }
      }}
      open={open}
    >
      <Tip label={`${self.name} (${t.presence.you}) · ${self.label}`}>
        <PopoverTrigger asChild>
          <button aria-label={t.presence.renameTitle} className="ml-2.5 rounded-full" data-slot="presence-self" type="button">
            <Avatar color={self.color} name={self.name} ring />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault()
            save()
          }}
        >
          <label className="text-xs font-medium text-(--ui-text-secondary)" htmlFor="presence-name">
            {t.presence.renameTitle}
          </label>
          <Input
            autoFocus
            id="presence-name"
            maxLength={40}
            onChange={event => setDraft(event.target.value)}
            placeholder={t.presence.renamePlaceholder}
            value={draft}
          />
          <p className="text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{t.presence.renameHint}</p>
          <Button disabled={!draft.trim()} size="sm" type="submit">
            {t.presence.renameSave}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
