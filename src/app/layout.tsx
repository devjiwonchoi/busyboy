import type { Metadata } from 'next'
import './globals.css'

// No web font: `shadcn init` adds next/font/google, which downloads the font
// during `next build` and fails offline builds. The theme uses the system
// font stack instead.
export const metadata: Metadata = {
  title: 'BusyBoy',
  description: 'Run coding tasks across projects with your installed agent CLIs.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
