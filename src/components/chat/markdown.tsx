'use client'

import { Streamdown } from 'streamdown'

/** Director text as Markdown. `streaming` tolerates unfinished syntax while a reply arrives. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      className="space-y-2 [&_pre]:text-xs"
    >
      {text}
    </Streamdown>
  )
}
