import { useEffect, useState } from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { TOUCH_POINTER_QUERY } from '@/lib/touch-interaction'

/**
 * Whether this window shares a pointer (else the message it is reading). The last input
 * decides: a mouse or pen moving means a pointer, a finger means reading. Before any input
 * the device's media features decide; they alone misjudge a tablet with a trackpad, a touch
 * laptop used with a mouse, or a browser that reports no hover-capable device at all.
 */
export function useSharesPointer(): boolean {
  const touchDevice = useMediaQuery(TOUCH_POINTER_QUERY)
  const [lastInput, setLastInput] = useState<'pointer' | 'touch' | null>(null)

  useEffect(() => {
    const onInput = (event: PointerEvent) => {
      const next = event.pointerType === 'touch' ? 'touch' : 'pointer'
      setLastInput(current => (current === next ? current : next))
    }

    document.addEventListener('pointermove', onInput, { passive: true })
    document.addEventListener('pointerdown', onInput, { passive: true })

    return () => {
      document.removeEventListener('pointermove', onInput)
      document.removeEventListener('pointerdown', onInput)
    }
  }, [])

  return lastInput ? lastInput === 'pointer' : !touchDevice
}
