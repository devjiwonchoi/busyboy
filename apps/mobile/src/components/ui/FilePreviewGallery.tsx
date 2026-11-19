import { createContext, useContext } from "react";

import { filePreviewGallery } from "../../lib/filePreviewGallery";
import type { FilePreviewItem, FilePreviewSource } from "./FilePreviewModal.types";

export const FilePreviewGallery = createContext<readonly FilePreviewItem[]>([]);

export function useFilePreviewGallery() {
  const group = useContext(FilePreviewGallery);
  return (source: FilePreviewSource): FilePreviewSource =>
    group.length === 0
      ? source
      : {
          ...source,
          gallery: filePreviewGallery(source, group),
        };
}
