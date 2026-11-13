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

/** Director text as Markdown. `streaming` tolerates unfinished syntax while a reply arrives. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      plugins={plugins}
      controls={controls}
      linkSafety={linkSafety}
      className="space-y-2 [&_pre]:text-xs"
    >
      {text}
    </Streamdown>
  )
}
