"use client";

import { useExternalSync } from "@/hooks/use-external-sync";
import { applyDocumentTheme } from "@/lib/theme";

export function ThemeSync() {
  useExternalSync(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyDocumentTheme();
    apply();
    media.addEventListener("change", apply);
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", apply);
      observer.disconnect();
    };
  }, []);
  return null;
}
