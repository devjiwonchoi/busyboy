import type { Metadata } from "next";
import type { CSSProperties } from "react";

import "./globals.css";

const systemFonts = {
  "--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
} as CSSProperties;

export const metadata: Metadata = {
  title: "BusyBoy",
  description: "Chat with your installed coding agent CLI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark" style={systemFonts}>
      <body>{children}</body>
    </html>
  );
}
