import type { Metadata } from "next";

import "./globals.css";

// why: next/font/google downloads the font during next build and fails offline.
export const metadata: Metadata = {
  title: "BusyBoy",
  description: "Run coding tasks across projects with your installed agent CLIs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
