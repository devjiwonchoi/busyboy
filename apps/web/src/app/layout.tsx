import type { ReactNode } from "react";
import legacyHtml from "../../index.html?raw";
import "../index.css";

// Reuse the existing early theme and splash styles so both entrypoints stay consistent.
const bootScript = legacyHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const bootStyles = legacyHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
export default function RootLayout({ children }: { children: ReactNode }) {
  if (bootScript === undefined || bootStyles === undefined) {
    throw new Error("The app's initial theme script and splash styles are missing.");
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>T3 Code (Dev)</title>
        <meta name="theme-color" content="#0a0a0a" />
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
        <style dangerouslySetInnerHTML={{ __html: bootStyles }} />
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
