'use client'

import { createContext, useContext, useEffect, useRef } from 'react'

export type Shortcut = {
  /** Unique id, for example `toggle-sidebar`. A later registration with the same id wins. */
  id: string
  /**
   * The `KeyboardEvent.key` value, compared case-insensitively. When the layout
   * types a non-ASCII character, single letters and digits match by physical key
   * (`KeyB`, `Digit1`), so shortcuts work while a non-Latin input source is active.
   */
  key: string
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean
  shift?: boolean
  alt?: boolean
  label: string
  run: () => void
}

type Registry = Map<string, Shortcut>

type Keys = Pick<Shortcut, 'key' | 'mod' | 'shift' | 'alt'>

// Cmd+Option+S (Ctrl+Alt+S elsewhere): B stays with the editors and shells the user also runs,
// and plain Cmd+S stays Save. Defined here so the terminal lets the same keys through.
export const TOGGLE_SIDEBAR_KEYS = { key: 's', mod: true, alt: true } as const
export const TOGGLE_PANEL_KEYS = { key: 'j', mod: true } as const

const ShortcutRegistryContext = createContext<Registry | null>(null)

/** True on macOS and iOS, where the shortcut modifier is Cmd instead of Ctrl. */
export function isMacPlatform() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

function physicalCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

/** Whether `event` presses `shortcut`; the terminal uses it too, so both agree on every layout. */
export function matchesShortcut(shortcut: Keys, event: KeyboardEvent, mac: boolean) {
  const mod = mac ? event.metaKey : event.ctrlKey
  const otherMod = mac ? event.ctrlKey : event.metaKey
  // AltGr (reported as Ctrl+Alt on Windows) types characters such as ś on a Polish layout; a
  // shortcut must never take them.
  if (!mac && event.getModifierState?.('AltGraph')) return false
  // Fall back to the physical key only when the layout types a non-ASCII
  // character there (Korean, Cyrillic). On Latin layouts such as Dvorak the
  // typed letter wins, so Cmd/Ctrl+X on the physical B key stays Cut. With
  // Option held macOS types another character (S types ß, or an ASCII symbol
  // on some layouts), so there Alt shortcuts always match by physical key. Ctrl+Alt elsewhere
  // types the plain letter, which keeps Dvorak users on the letter they see.
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

/** Owns the one keydown listener; features add shortcuts with `useShortcut`. */
export function ShortcutRegistryProvider({ children }: { children: React.ReactNode }) {
  const registry = useRef<Registry>(new Map())

  useEffect(() => {
    const mac = isMacPlatform()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // Plain keys belong to an active input method; modifier shortcuts still apply.
      if (event.isComposing && !event.metaKey && !event.ctrlKey) return
      for (const shortcut of registry.current.values()) {
        if (!matchesShortcut(shortcut, event, mac)) continue
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

/** Registers a keyboard shortcut while the calling component is mounted. */
export function useShortcut(shortcut: Shortcut) {
  const registry = useContext(ShortcutRegistryContext)
  if (!registry) throw new Error('useShortcut must be used inside ShortcutRegistryProvider.')
  const latest = useRef(shortcut)
  useEffect(() => {
    latest.current = shortcut
  })

  const { id, key, mod, shift, alt, label } = shortcut
  useEffect(() => {
    const entry: Shortcut = { id, key, mod, shift, alt, label, run: () => latest.current.run() }
    registry.set(id, entry)
    return () => {
      if (registry.get(id) === entry) registry.delete(id)
    }
  }, [registry, id, key, mod, shift, alt, label])
}

/** Formats a shortcut for display, for example `⌘B` on macOS and `Ctrl+B` elsewhere. */
export function formatShortcut(shortcut: Pick<Shortcut, 'key' | 'mod' | 'shift' | 'alt'>, mac: boolean) {
  const key = shortcut.key.toUpperCase()
  if (mac) {
    return `${shortcut.mod ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`
  }
  return [shortcut.mod && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key].filter(Boolean).join('+')
}
