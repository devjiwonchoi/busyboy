import type { ITheme } from '@xterm/xterm'

// ANSI colors tuned to read on the app's light and dark backgrounds.
const lightAnsi: ITheme = {
  black: '#1f2328',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
}

const darkAnsi: ITheme = {
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

/**
 * xterm.js only understands hex and rgb colors, while the app's tokens are
 * oklch. Paint each token on a canvas and read the pixel back as hex.
 */
function tokenColor(host: HTMLElement, token: string, context: CanvasRenderingContext2D) {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  host.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = computed
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  const hex = (value: number) => value.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ''}`
}

export function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Builds the terminal theme from the app's current color tokens. */
export function readTerminalTheme(host: HTMLElement): ITheme {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const ansi = prefersDark() ? darkAnsi : lightAnsi
  if (!context) return ansi
  const foreground = tokenColor(host, '--foreground', context)
  return {
    ...ansi,
    background: tokenColor(host, '--background', context),
    foreground,
    cursor: foreground,
    cursorAccent: tokenColor(host, '--background', context),
    selectionBackground: prefersDark() ? '#ffffff33' : '#0000001f',
  }
}
