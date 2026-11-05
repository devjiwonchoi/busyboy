import type { BrowserPasswordAutofillEvent } from "@t3tools/contracts";
import { create } from "zustand";

export type PasswordFillListState = Extract<BrowserPasswordAutofillEvent, { type: "fillList" }>;
export type PasswordSavePromptState = Extract<BrowserPasswordAutofillEvent, { type: "savePrompt" }>;

interface PasswordAutofillStoreState {
  /** BusyBoy's fill list per runtime tab, drawn over the page. */
  readonly fillLists: Record<string, PasswordFillListState>;
  /** The save or update prompt per runtime tab. The typed password stays in main. */
  readonly prompts: Record<string, PasswordSavePromptState>;
  readonly apply: (event: BrowserPasswordAutofillEvent) => void;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const usePasswordAutofillStore = create<PasswordAutofillStoreState>()((set) => ({
  fillLists: {},
  prompts: {},
  apply: (event) =>
    set((state) => {
      switch (event.type) {
        case "fillList":
          return { fillLists: { ...state.fillLists, [event.tabId]: event } };
        case "fillListClosed":
          return { fillLists: without(state.fillLists, event.tabId) };
        case "savePrompt":
          return { prompts: { ...state.prompts, [event.tabId]: event } };
        case "savePromptClosed":
          return { prompts: without(state.prompts, event.tabId) };
      }
    }),
}));
