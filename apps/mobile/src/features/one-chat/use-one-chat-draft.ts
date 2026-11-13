import { useCallback, useMemo } from "react";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";

/** The persisted composer draft for a thread: text and attachments survive restarts. */
export function useOneChatDraft(draftKey: string | null) {
  const draft = useComposerDraft(draftKey);
  const setText = useCallback(
    (text: string) => {
      if (draftKey !== null) setComposerDraftText(draftKey, text);
    },
    [draftKey],
  );
  const addAttachments = useCallback(
    (attachments: ReadonlyArray<DraftComposerAttachment>) =>
      draftKey === null ? attachments.length : appendComposerDraftAttachments(draftKey, attachments),
    [draftKey],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      if (draftKey !== null) removeComposerDraftAttachment(draftKey, id);
    },
    [draftKey],
  );
  const clear = useCallback(() => {
    if (draftKey !== null) clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
  }, [draftKey]);
  return useMemo(
    () => ({
      text: draft.text,
      attachments: draft.attachments,
      setText,
      addAttachments,
      removeAttachment,
      clear,
    }),
    [draft.text, draft.attachments, setText, addAttachments, removeAttachment, clear],
  );
}
