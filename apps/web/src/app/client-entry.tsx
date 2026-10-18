"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

function BootSplash() {
  return (
    <div id="boot-shell">
      <div id="boot-shell-card" aria-label="T3 Code splash screen">
        <img id="boot-shell-logo" src="/apple-touch-icon.png" alt="T3 Code" />
      </div>
    </div>
  );
}

// The existing UI reads browser storage and the preload bridge at module load time.
const ClientApp = dynamic(() => import("../main"), {
  ssr: false,
  loading: BootSplash,
});

export default function ClientEntry() {
  return (
    <Suspense fallback={<BootSplash />}>
      <ClientApp />
    </Suspense>
  );
}
