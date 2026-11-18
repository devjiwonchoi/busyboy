import type { Metadata } from "next";
import localFont from "next/font/local";

import { cn } from "@/lib/utils";

import "./globals.css";

// why: shadcn's theme reads --font-sans, and the geist package hardcodes --font-geist-sans.
const geistSans = localFont({
  src: "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "BusyBoy",
  description: "Chat with your installed coding agent CLI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("dark", "font-sans", geistSans.variable, geistMono.variable)}
      data-theme="dark"
    >
      <body>{children}</body>
    </html>
  );
}
