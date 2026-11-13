import type { Metadata } from 'next'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

export const metadata: Metadata = {
  title: 'Busyboy',
  description: 'Run coding tasks across projects with your installed agent CLIs.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
