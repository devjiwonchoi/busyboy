'use client'

import { ArrowUp, Square } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerItem,
  type ComposerItemValue,
  ComposerList,
  ComposerPopup,
  ComposerSubmit,
  type ComposerValue,
  getComposerText,
} from '@/components/ui/composer'

/**
 * The message box. Enter sends, Shift+Enter adds a line. Typing `@` opens a
 * project picker: arrow keys move, Enter chooses, Escape or Tab closes it
 * (the library composer's keys).
 */
export function ChatComposer({
  projects,
  placeholder,
  onSend,
  onStop,
}: {
  projects: string[]
  placeholder: string
  /** May reject; the text then comes back into an empty box. */
  onSend: (text: string) => Promise<void> | void
  /** Shown as a Stop button while there is work to stop. */
  onStop?: () => void
}) {
  const [value, setValue] = useState<ComposerValue>([])
  // A chosen project becomes a mention token. getComposerText turns it back
  // into `@name`, the text the Director reads. Plain-text insertion would not
  // work: the inserted `@name` matches the `@` query again and reopens the
  // picker, so the next Enter would pick instead of send.
  const items: ComposerItemValue[] = projects.map((name) => ({ id: name, label: name }))

  function send(draft: ComposerValue) {
    const message = getComposerText(draft).trim()
    if (!message) return
    setValue([])
    Promise.resolve(onSend(message)).catch(() => {
      // Bring the message back only if nothing new was typed meanwhile.
      setValue((current) => (getComposerText(current).trim() ? current : [{ type: 'text', text: message }]))
    })
  }

  return (
    <Composer value={value} onValueChange={setValue} onSubmit={send} triggers={[{ character: '@', items }]}>
      <ComposerInput aria-label="Message" placeholder={placeholder} />
      <ComposerPopup>
        <ComposerList aria-label="Choose a project">
          {(item: ComposerItemValue) => (
            <ComposerItem key={item.id} value={item}>
              <span className="truncate">@{item.label}</span>
            </ComposerItem>
          )}
        </ComposerList>
      </ComposerPopup>
      <ComposerActions>
        <ComposerActionGroup align="end">
          {onStop && (
            <Button type="button" variant="outline" size="icon-sm" aria-label="Stop" onClick={onStop}>
              <Square />
            </Button>
          )}
          <ComposerSubmit
            render={
              <Button size="icon-sm" aria-label="Send">
                <ArrowUp />
              </Button>
            }
          />
        </ComposerActionGroup>
      </ComposerActions>
    </Composer>
  )
}
