'use client'

import { code } from '@streamdown/code'
import { Streamdown, type ControlsConfig, type LinkSafetyConfig } from 'streamdown'
import { MermaidBlock } from './mermaid-block'

// Streamdown 2 highlights only through this plugin, and switches to dark colors with the dark: variant.
const plugins = { code, renderers: [{ language: 'mermaid', component: MermaidBlock }] }

// Streamdown's other controls are not from our component library.
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
}

// The desktop app already opens links in the browser, so Streamdown's link modal is a second prompt.
const linkSafety: LinkSafetyConfig = { enabled: false }

// Streamdown's default sizes are for a document page, not a text-xs chat bubble.
const scale = [
  'space-y-2',
  '[&_[data-streamdown=heading-1]]:mt-3 [&_[data-streamdown=heading-1]]:mb-1 [&_[data-streamdown=heading-1]]:text-sm',
  '[&_[data-streamdown=heading-2]]:mt-3 [&_[data-streamdown=heading-2]]:mb-1 [&_[data-streamdown=heading-2]]:text-[13px]',
  '[&_:is(h3,h4,h5,h6)]:mt-3 [&_:is(h3,h4,h5,h6)]:mb-1 [&_:is(h3,h4,h5,h6)]:text-xs',
  // Streamdown's bg-muted matches the Director bubble, so inline code would show no chip.
  '[&_[data-streamdown=inline-code]]:bg-foreground/10 [&_[data-streamdown=inline-code]]:px-1 [&_[data-streamdown=inline-code]]:py-0 [&_[data-streamdown=inline-code]]:text-[0.9em]',
  '[&_[data-streamdown=code-block]]:my-2 [&_[data-streamdown=code-block-body]]:p-3 [&_[data-streamdown=code-block-body]]:text-[0.9em]',
  '[&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_:is(th,td)]:text-xs',
  '[&_[data-streamdown=horizontal-rule]]:my-3 [&_[data-streamdown=blockquote]]:my-2',
  // GFM task items already show a checkbox; the list's disc bullet would be a second marker.
  '[&_li.task-list-item]:list-none',
].join(' ')

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      plugins={plugins}
      controls={controls}
      linkSafety={linkSafety}
      className={scale}
    >
      {text}
    </Streamdown>
  )
}
