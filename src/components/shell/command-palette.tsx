'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { commandPaletteAction } from '@/app/(main)/palette-actions'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import type { PaletteChat, SearchHit } from '@/server/search-chats'
import {
  COMMAND_PALETTE_KEYS,
  formatShortcut,
  isMacPlatform,
  NEW_TASK_KEYS,
  useShortcut,
} from './shortcut-registry'

type Item = { id: string; label: string; detail?: string; run: () => void }

function subscribeNothing() {
  return () => {}
}

export function openNewManager() {
  document.querySelector<HTMLButtonElement>('button[aria-label="New manager"]')?.click()
}

function sameList<T>(left: T[], right: T[]) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function chatHref(id: string | null) {
  return id ? `/?manager=${encodeURIComponent(id)}` : '/'
}

export function CommandPalette() {
  const router = useRouter()
  const mac = useSyncExternalStore(subscribeNothing, isMacPlatform, () => true)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [chats, setChats] = useState<PaletteChat[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)

  useShortcut({
    id: 'command-palette',
    label: 'Command palette',
    ...COMMAND_PALETTE_KEYS,
    run: () => {
      setQuery('')
      setOpen((value) => !value)
    },
  })
  useShortcut({
    id: 'new-task',
    label: 'New task',
    ...NEW_TASK_KEYS,
    run: () => {
      setOpen(false)
      openNewManager()
    },
  })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const handle = setTimeout(() => {
      void commandPaletteAction(query).then(
        (result) => {
          if (cancelled) return
          setChats((current) => (sameList(current, result.chats) ? current : result.chats))
          setHits((current) => (sameList(current, result.hits) ? current : result.hits))
        },
        () => {
          if (!cancelled) setHits([])
        },
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, query])

  function close() {
    setOpen(false)
    setQuery('')
  }

  function go(href: string) {
    close()
    router.push(href)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  const needle = query.trim().toLowerCase()
  const matches = (label: string) => !needle || label.toLowerCase().includes(needle)
  const items: Item[] = [
    matches('New task') ? { id: 'new-task', label: 'New task', run: () => { close(); openNewManager() } } : undefined,
    matches('Settings') ? { id: 'settings', label: 'Settings', run: () => { close(); router.push('/settings') } } : undefined,
    ...chats
      .filter((chat) => matches(`Switch to ${chat.name}`))
      .map((chat) => ({ id: `chat-${chat.id ?? 'director'}`, label: `Switch to ${chat.name}`, run: () => go(chatHref(chat.id)) })),
    ...hits.map((hit) => ({
      id: `${hit.kind}-${hit.anchor}`,
      label: hit.kind === 'task' ? hit.title : `${hit.title}: ${hit.snippet}`,
      detail: hit.kind === 'task' ? `${hit.chatName} · ${hit.snippet}` : hit.chatName,
      run: () => go(`${chatHref(hit.chat)}#${hit.anchor}`),
    })),
  ].filter((item): item is Item => Boolean(item))

  const current = Math.min(active, Math.max(items.length - 1, 0))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Commands</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="Search chats and commands"
          aria-controls="command-palette-list"
          aria-activedescendant={items[current] ? `command-${items[current].id}` : undefined}
          placeholder="Search chats, tasks, and commands"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((index) => Math.min(index + 1, items.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && items[current]) {
              event.preventDefault()
              items[current].run()
            }
          }}
        />
        <ul id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-80 space-y-0.5 overflow-y-auto">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                id={`command-${item.id}`}
                type="button"
                role="option"
                aria-selected={index === current}
                className="hover:bg-muted aria-selected:bg-muted flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left"
                onMouseEnter={() => setActive(index)}
                onClick={item.run}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.detail && <span className="text-muted-foreground shrink-0 truncate text-xs">{item.detail}</span>}
                {item.id === 'new-task' && <Kbd>{formatShortcut(NEW_TASK_KEYS, mac)}</Kbd>}
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="text-muted-foreground px-2 py-3 text-xs">No matches.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
