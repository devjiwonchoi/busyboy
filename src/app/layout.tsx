import type { Metadata } from "next";
import Script from "next/script";

import { ThemeSync } from "@/components/theme/theme-sync";
import { THEME_BOOT } from "@/lib/theme";

import "./globals.css";

// next/font/google downloads the font during next build and fails offline.
export const metadata: Metadata = {
  title: "BusyBoy",
  description: "Run coding tasks across projects with your installed agent CLIs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Dark is the default. A saved choice is applied by the boot script before paint, from a cookie,
  // so this layout stays static (the root layout wraps pages Next prerenders, including not-found).
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <body>
        <Script id="busyboy-theme" strategy="beforeInteractive">
          {THEME_BOOT}
        </Script>
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
