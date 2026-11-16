'use client'

import { code } from '@streamdown/code'
import { Streamdown, type ControlsConfig, type LinkSafetyConfig } from 'streamdown'

// Streamdown 2 highlights code only through this plugin; without it every token is one color.
// Its default themes are github-light and github-dark, and Streamdown switches tokens to the
// dark colors with the `dark:` variant, which globals.css ties to prefers-color-scheme.
const plugins = { code }

// Code copy stays: it is a single button and the one control a chat reply needs. Every
// other control (table copy and download menus, fullscreen dialogs, file downloads) is UI
// Streamdown builds itself rather than our component library, so it is turned off.
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
}

// Streamdown asks "Open external link?" in a modal of its own before following a link.
// The desktop app's setWindowOpenHandler (electron/main.ts) already opens every link a
// page opens in the user's browser, never inside BusyBoy, so that modal only adds a click
// and more UI outside our component library.
const linkSafety: LinkSafetyConfig = { enabled: false }

// Streamdown sizes its elements for a document page (text-3xl/2xl headings, text-sm code and
// table cells, my-4/mt-6 gaps). Inside a chat bubble the body text is text-xs, so these
// selectors scale every element from the bubble's size instead. They target the
// `data-streamdown` attributes Streamdown puts on each element.
const scale = [
  'space-y-2',
  // Headings: one small step above the body text, never twice its size.
  '[&_[data-streamdown=heading-1]]:mt-3 [&_[data-streamdown=heading-1]]:mb-1 [&_[data-streamdown=heading-1]]:text-sm',
  '[&_[data-streamdown=heading-2]]:mt-3 [&_[data-streamdown=heading-2]]:mb-1 [&_[data-streamdown=heading-2]]:text-[13px]',
  '[&_:is(h3,h4,h5,h6)]:mt-3 [&_:is(h3,h4,h5,h6)]:mb-1 [&_:is(h3,h4,h5,h6)]:text-xs',
  // Code reads a little smaller than the prose around it, like inline code in most editors.
  // Streamdown fills inline code with bg-muted, the Director bubble's own color, so it would
  // show no chip; a foreground tint stays visible on any bubble color.
  '[&_[data-streamdown=inline-code]]:bg-foreground/10 [&_[data-streamdown=inline-code]]:px-1 [&_[data-streamdown=inline-code]]:py-0 [&_[data-streamdown=inline-code]]:text-[0.9em]',
  '[&_[data-streamdown=code-block]]:my-2 [&_[data-streamdown=code-block-body]]:p-3 [&_[data-streamdown=code-block-body]]:text-[0.9em]',
  '[&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_:is(th,td)]:text-xs',
  '[&_[data-streamdown=horizontal-rule]]:my-3 [&_[data-streamdown=blockquote]]:my-2',
  // GFM task items already show a checkbox; the list's disc bullet would be a second marker.
  '[&_li.task-list-item]:list-none',
].join(' ')

/** Director text as Markdown. `streaming` tolerates unfinished syntax while a reply arrives. */
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
