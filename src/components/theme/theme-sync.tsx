'use client'

import { useEffect } from 'react'
import { applyDocumentTheme } from '@/lib/theme'

/**
 * Keeps the `dark` class on `<html>` after the boot script: a settings change
 * updates `data-theme`, and System follows the device while the page is open.
 */
export function ThemeSync() {
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyDocumentTheme()
    apply()
    media.addEventListener('change', apply)
    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener('change', apply)
      observer.disconnect()
    }
  }, [])
  return null
}
