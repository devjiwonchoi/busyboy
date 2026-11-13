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

const ShortcutRegistryContext = createContext<Registry | null>(null)

function isMacPlatform() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

function physicalCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

function matches(shortcut: Shortcut, event: KeyboardEvent, mac: boolean) {
  const mod = mac ? event.metaKey : event.ctrlKey
  const otherMod = mac ? event.ctrlKey : event.metaKey
  // Fall back to the physical key only when the layout types a non-ASCII
  // character there (Korean, Cyrillic). On Latin layouts such as Dvorak the
  // typed letter wins, so Cmd/Ctrl+X on the physical B key stays Cut.
  const typesAscii = /^[\x20-\x7e]$/.test(event.key)
  const sameKey =
    event.key.toLowerCase() === shortcut.key.toLowerCase() ||
    (!typesAscii && event.code === physicalCode(shortcut.key))
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
        if (!matches(shortcut, event, mac)) continue
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
