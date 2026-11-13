'use client'

import { ArrowUp } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Mention = { start: number; query: string }

/** The `@word` that ends right at the caret, if any. */
function mentionAt(text: string, caret: number): Mention | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[2].length - 1, query: match[2] } : undefined
}

/**
 * The message box. Enter sends, Shift+Enter adds a line. Typing `@` opens a
 * project picker: arrow keys move, Enter or Tab chooses, Escape closes. The
 * chosen project is inserted as `@name` text.
 */
export function Composer({ projects, onSend }: { projects: string[]; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  /** The mention start the user closed with Escape; it stays closed until another `@`. */
  const [dismissed, setDismissed] = useState<number>()
  const input = useRef<HTMLTextAreaElement>(null)
  const listId = useId()

  const mention = mentionAt(text, caret)
  const query = mention?.query.toLowerCase() ?? ''
  const matches = mention
    ? projects
        .filter((name) => name.toLowerCase().includes(query))
        .sort((a, b) => Number(!a.toLowerCase().startsWith(query)) - Number(!b.toLowerCase().startsWith(query)))
    : []
  const open = Boolean(mention) && mention?.start !== dismissed && matches.length > 0
  const activeIndex = Math.min(active, matches.length - 1)

  function update(value: string, position: number) {
    setText(value)
    setCaret(position)
    setActive(0)
    if (dismissed !== undefined && mentionAt(value, position)?.start !== dismissed) setDismissed(undefined)
  }

  function choose(name: string) {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice(caret).replace(/^\S*/, '')
    const inserted = `@${name} `
    const position = before.length + inserted.length
    update(`${before}${inserted}${after.replace(/^ /, '')}`, position)
    requestAnimationFrame(() => input.current?.setSelectionRange(position, position))
  }

  function send() {
    const message = text.trim()
    if (!message) return
    onSend(message)
    update('', 0)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((activeIndex + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(matches[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(mention?.start)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form
      className="bg-card relative rounded-xl border p-2 shadow-xs"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Choose a project"
          className="bg-popover text-popover-foreground absolute bottom-full left-0 mb-2 max-h-60 w-64 overflow-y-auto rounded-lg border p-1 shadow-md"
        >
          {matches.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                'cursor-pointer truncate rounded-md px-2 py-1.5 text-sm',
                index === activeIndex && 'bg-accent text-accent-foreground',
              )}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(name)
              }}
              onMouseEnter={() => setActive(index)}
            >
              @{name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={input}
          aria-label="Message"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
          rows={1}
          value={text}
          placeholder="Message the master. Type @ to name a project."
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          onChange={(event) => update(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={!text.trim()}>
          <ArrowUp />
        </Button>
      </div>
    </form>
  )
}
