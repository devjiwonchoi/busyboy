import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "BusyBoy",
  description: "Chat with your installed coding agent CLI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
