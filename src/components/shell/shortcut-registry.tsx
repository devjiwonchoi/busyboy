'use client'

import { createContext, useContext, useEffect, useRef } from 'react'

export type Shortcut = {
  id: string
  // When the layout types a non-ASCII character, letters match by physical key.
  key: string
  mod?: boolean
  shift?: boolean
  alt?: boolean
  label: string
  // Escape to stop a reply uses handles, so a key repeat does not stop twice.
  handles?: (event: KeyboardEvent) => boolean
  run: () => void
}

type Registry = Map<string, Shortcut>

type Keys = Pick<Shortcut, 'key' | 'mod' | 'shift' | 'alt'>

export const TOGGLE_PANEL_KEYS = { key: 'j', mod: true } as const
export const COMMAND_PALETTE_KEYS = { key: 'k', mod: true } as const
export const NEW_TASK_KEYS = { key: 'n', mod: true } as const

const ShortcutRegistryContext = createContext<Registry | null>(null)

export function isMacPlatform() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

function physicalCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

export function matchesShortcut(shortcut: Keys, event: KeyboardEvent, mac: boolean) {
  const mod = mac ? event.metaKey : event.ctrlKey
  const otherMod = mac ? event.ctrlKey : event.metaKey
  // AltGr (reported as Ctrl+Alt on Windows) types characters such as ś on a Polish layout; a
  // shortcut must never take them.
  if (!mac && event.getModifierState?.('AltGraph')) return false
  // Korean and Cyrillic need the physical key; Dvorak must keep the typed letter. Option on macOS types another character.
  const typesAscii = /^[\x20-\x7e]$/.test(event.key)
  const sameKey = shortcut.alt && mac
    ? event.code === physicalCode(shortcut.key)
    : event.key.toLowerCase() === shortcut.key.toLowerCase() || (!typesAscii && event.code === physicalCode(shortcut.key))
  return (
    sameKey &&
    mod === Boolean(shortcut.mod) &&
    !otherMod &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.altKey === Boolean(shortcut.alt)
  )
}

export function ShortcutRegistryProvider({ children }: { children: React.ReactNode }) {
  const registry = useRef<Registry>(new Map())

  useEffect(() => {
    const mac = isMacPlatform()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.isComposing && !event.metaKey && !event.ctrlKey) return
      for (const shortcut of registry.current.values()) {
        if (!matchesShortcut(shortcut, event, mac)) continue
        if (shortcut.handles && !shortcut.handles(event)) continue
        event.preventDefault()
        shortcut.run()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return <ShortcutRegistryContext value={registry.current}>{children}</ShortcutRegistryContext>
}

// React does not pass a JSX key through, so the shortcut would match nothing.
export function EscapeShortcut({
  id,
  label,
  handles,
  run,
}: {
  id: string
  label: string
  handles?: (event: KeyboardEvent) => boolean
  run: () => void
}) {
  useShortcut({ id, key: 'Escape', label, handles, run })
  return null
}

export function useShortcut(shortcut: Shortcut) {
  const registry = useContext(ShortcutRegistryContext)
  if (!registry) throw new Error('useShortcut must be used inside ShortcutRegistryProvider.')
  const latest = useRef(shortcut)
  useEffect(() => {
    latest.current = shortcut
  })

  const { id, key, mod, shift, alt, label } = shortcut
  useEffect(() => {
    const entry: Shortcut = {
      id,
      key,
      mod,
      shift,
      alt,
      label,
      handles: (event) => latest.current.handles?.(event) ?? true,
      run: () => latest.current.run(),
    }
    registry.set(id, entry)
    return () => {
      if (registry.get(id) === entry) registry.delete(id)
    }
  }, [registry, id, key, mod, shift, alt, label])
}

export function formatShortcut(shortcut: Pick<Shortcut, 'key' | 'mod' | 'shift' | 'alt'>, mac: boolean) {
  const key = shortcut.key.toUpperCase()
  if (mac) {
    return `${shortcut.mod ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`
  }
  return [shortcut.mod && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key].filter(Boolean).join('+')
}
