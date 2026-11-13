'use client'

import { createContext, useContext, useEffect, useRef } from 'react'

export type Shortcut = {
  /** Unique id, for example `toggle-sidebar`. A later registration with the same id wins. */
  id: string
  /** The `KeyboardEvent.key` value, compared case-insensitively. */
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

function matches(shortcut: Shortcut, event: KeyboardEvent, mac: boolean) {
  const mod = mac ? event.metaKey : event.ctrlKey
  const otherMod = mac ? event.ctrlKey : event.metaKey
  return (
    event.key.toLowerCase() === shortcut.key.toLowerCase() &&
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
      if (event.defaultPrevented || event.isComposing) return
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
