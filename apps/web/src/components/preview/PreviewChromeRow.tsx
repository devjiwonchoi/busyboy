import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
} from "lucide-react";
import type { BrowserHistoryNavigationHint } from "@t3tools/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import { AddressBarSuggestionList, addressBarOptionId } from "./AddressBarSuggestionList";
import {
  type AddressBarRow,
  type AddressBarSuggestionData,
  addressBarCompletion,
  addressBarDisplayValue,
  addressBarEscapeAction,
  addressBarMode,
  buildTypingRows,
  buildZeroStateRows,
  canReplaceRows,
  defaultSelectionIndex,
  isRemoveSuggestionShortcut,
  moveSelection,
  suppressesCompletion,
} from "./addressBarSuggestions.logic";
import { useAddressBarSuggestionData } from "./useAddressBarSuggestionData";

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  focusUrlNonce?: number | undefined;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  /** Typed text; the view resolves it into a URL or a search. */
  onSubmit: (text: string) => void;
  /** An accepted suggestion row that already knows its URL. */
  onNavigate?: ((url: string, transition: BrowserHistoryNavigationHint) => void) | undefined;
  /**
   * The profile whose history feeds suggestions, or null for none (incognito,
   * server tabs). Without it only the typed and search rows show.
   */
  suggestionsProfileId?: string | null | undefined;
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  pickDisabledReason?: string | undefined;
  trailingActions?: ReactNode;
  leadingActions?: ReactNode;
}

const NOOP = () => {};

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Whether a tap at `clientX` lands past the typed `draft`, on the completed text. */
function isTapOnCompletion(input: HTMLInputElement, clientX: number, draft: string): boolean {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return true;
  const style = getComputedStyle(input);
  measureContext.font = style.font;
  const textX =
    clientX -
    input.getBoundingClientRect().left -
    parseFloat(style.borderLeftWidth) -
    parseFloat(style.paddingLeft) +
    input.scrollLeft;
  return textX >= measureContext.measureText(draft).width;
}

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  focusUrlNonce,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onNavigate,
  suggestionsProfileId = null,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  trailingActions,
  leadingActions,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const listId = useId();
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  // Whether the user changed the text since focusing; untouched means zero state.
  const [edited, setEdited] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [suppressCompletion, setSuppressCompletion] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [removedUrls, setRemovedUrls] = useState<ReadonlySet<string>>(() => new Set());

  const searchEngine = useClientSettings((settings) => settings.browserSearchEngine);
  const customSearchUrl = useClientSettings((settings) => settings.browserCustomSearchUrl);
  const zeroStateEnabled = useClientSettings((settings) => settings.browserZeroStateSuggestions);
  const remoteSetting = useClientSettings((settings) => settings.browserRemoteSearchSuggestions);
  // Incognito and server tabs pass no profile: no history and no search suggestions.
  const remoteEnabled = remoteSetting && suggestionsProfileId !== null;

  const mode = addressBarMode({ typed: draft, edited });
  const defaultIndex = defaultSelectionIndex(mode);
  const { data: latestData, removeUrl } = useAddressBarSuggestionData({
    profileId: suggestionsProfileId,
    active: inputFocused,
    text: mode === "typing" ? draft.trim() : "",
    zeroStateEnabled,
    remoteEnabled,
  });

  const build = (data: AddressBarSuggestionData) => {
    if (mode === "zero") {
      return {
        completion: null,
        rows: zeroStateEnabled ? buildZeroStateRows(data.frequent, removedUrls) : [],
      };
    }
    // Closing the dropdown with Esc also drops the completion.
    const completion = addressBarCompletion({
      typed: draft,
      data,
      caretAtEnd,
      suppressed: suppressCompletion || !dropdownOpen,
    });
    const rows = buildTypingRows({
      typed: draft,
      completion,
      data,
      remoteEnabled,
      search: { engine: searchEngine, customSearchUrl },
      removedUrls,
    });
    return { completion, rows };
  };

  // Results that would move the highlighted row wait until the selection
  // returns to the default or the text changes.
  const [shownData, setShownData] = useState(latestData);
  const shown = build(shownData);
  if (shownData !== latestData) {
    const next = build(latestData);
    if (canReplaceRows({ current: shown.rows, next: next.rows, selectedIndex, defaultIndex })) {
      setShownData(latestData);
    }
  }
  const { completion, rows } = shown;
  const activeIndex = Math.min(selectedIndex, rows.length - 1);
  const listVisible = inputFocused && dropdownOpen && rows.length > 0;
  const displayValue = addressBarDisplayValue({
    typed: draft,
    completion,
    rows,
    selectedIndex: activeIndex,
    defaultIndex,
  });

  useEffect(() => {
    if (focusUrlNonce == null) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
  }, [focusUrlNonce]);

  // Show the inline completion as a selected range after the caret, so typing
  // replaces it and Backspace removes it.
  const completionSuffix = completion?.suffix ?? "";
  const showingCompletion =
    inputFocused && completionSuffix.length > 0 && activeIndex === defaultIndex;
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node || !showingCompletion) return;
    node.setSelectionRange(draft.length, draft.length + completionSuffix.length, "backward");
  }, [completionSuffix, draft, showingCompletion]);

  const resetSession = (text: string) => {
    setDraft(text);
    setEdited(false);
    setSuppressCompletion(false);
    setCaretAtEnd(true);
    setSelectedIndex(-1);
  };

  const finish = () => {
    setDropdownOpen(false);
    inputRef.current?.blur();
  };

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const row = listVisible || mode === "typing" ? rows[activeIndex] : undefined;
    if (row) {
      accept(row);
      return;
    }
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    finish();
  };

  const accept = (row: AddressBarRow) => {
    if (row.action.type === "submit" || !onNavigate) {
      onSubmit(row.action.type === "submit" ? row.action.text : row.action.url);
    } else {
      onNavigate(row.action.url, row.action.transition);
    }
    finish();
  };

  const remove = (row: AddressBarRow) => {
    if (row.kind !== "history") return;
    setRemovedUrls((current) => new Set(current).add(row.url));
    removeUrl(row.url);
  };

  // Moving the caret or Tab keeps the completed text as if it had been typed.
  const commitCompletion = () => {
    setDraft(draft + completionSuffix);
    setSuppressCompletion(true);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const node = event.target;
    const value = node.value;
    const inputType = (event.nativeEvent as InputEvent).inputType;
    setDraft(value);
    setEdited(true);
    setDropdownOpen(true);
    setSuppressCompletion(suppressesCompletion(inputType));
    setCaretAtEnd(node.selectionStart === value.length && node.selectionEnd === value.length);
    setSelectedIndex(defaultSelectionIndex(addressBarMode({ typed: value, edited: true })));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "Enter":
        submit(event);
        return;
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!dropdownOpen) {
          setDropdownOpen(true);
          return;
        }
        if (rows.length === 0) return;
        setSelectedIndex(
          moveSelection({
            index: activeIndex,
            delta: event.key === "ArrowDown" ? 1 : -1,
            rowCount: rows.length,
            defaultIndex,
          }),
        );
        return;
      }
      case "Tab":
        if (showingCompletion && !event.shiftKey) {
          event.preventDefault();
          commitCompletion();
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        if (showingCompletion) commitCompletion();
        return;
      case "Escape": {
        event.preventDefault();
        const action = addressBarEscapeAction({
          open: listVisible,
          selectionMoved: activeIndex !== defaultIndex,
          edited,
        });
        if (action === "restore-typed") setSelectedIndex(defaultIndex);
        else if (action === "close") {
          setDropdownOpen(false);
          setSelectedIndex(defaultIndex);
        } else if (action === "revert") {
          resetSession(url);
          queueMicrotask(() => inputRef.current?.select());
        } else inputRef.current?.blur();
        return;
      }
      default:
        if (isRemoveSuggestionShortcut(event)) {
          const row = listVisible ? rows[activeIndex] : undefined;
          if (row?.kind === "history") {
            event.preventDefault();
            remove(row);
          }
        }
    }
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? "Stop" : "Refresh"}
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Refresh"}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <InputGroup ref={setAnchor} variant="ghost" className="group/address h-7 flex-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupInput
                  ref={inputRef}
                  value={inputFocused ? displayValue : url}
                  onChange={handleChange}
                  onFocus={() => {
                    resetSession(url);
                    setRemovedUrls(new Set());
                    setInputFocused(true);
                    setDropdownOpen(true);
                    queueMicrotask(() => inputRef.current?.select());
                  }}
                  onBlur={() => {
                    setInputFocused(false);
                    setDropdownOpen(false);
                  }}
                  onKeyDown={handleKeyDown}
                  onPointerUp={(event) => {
                    // Phones have no Tab key: tapping the completed text accepts it.
                    // A tap on the typed text leaves the completion pending.
                    if (event.pointerType === "mouse" || !showingCompletion) return;
                    if (!isTapOnCompletion(event.currentTarget, event.clientX, draft)) return;
                    const end = draft.length + completionSuffix.length;
                    commitCompletion();
                    queueMicrotask(() => inputRef.current?.setSelectionRange(end, end));
                  }}
                  role="combobox"
                  aria-autocomplete="both"
                  aria-expanded={listVisible}
                  aria-controls={listVisible ? listId : undefined}
                  aria-activedescendant={
                    listVisible && activeIndex >= 0
                      ? addressBarOptionId(listId, activeIndex)
                      : undefined
                  }
                  placeholder="Search or enter URL"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={inputDisabled}
                  data-preview-url-input
                  size="sm"
                />
              }
            />
          </Tooltip>
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon align="inline-end">
              {}
              <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onOpenInBrowser}
                        aria-label="Open in system browser"
                        type="button"
                      />
                    }
                  >
                    <ExternalLink />
                  </TooltipTrigger>
                  <TooltipPopup>Open in system browser</TooltipPopup>
                </Tooltip>
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                  aria-pressed={pickActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <MousePointerClick className={cn(pickActive && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pickDisabled && pickDisabledReason
                ? pickDisabledReason
                : pickActive
                  ? "Cancel annotation (Esc)"
                  : "Annotate elements, regions, and drawings"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={recording ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={(event) => onCapture(event.shiftKey)}
                  aria-label={recording ? "Stop recording" : "Capture screenshot"}
                  type="button"
                  className="relative"
                  disabled={captureDisabled}
                />
              }
            >
              <Camera className={cn(recording && "text-destructive")} />
              {recording ? (
                <span className="absolute right-0.5 top-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onPictureInPicture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pictureInPicture ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPictureInPicture}
                  aria-label={
                    pictureInPicture ? "Close floating preview" : "Float preview over chat"
                  }
                  aria-pressed={pictureInPicture ? "true" : "false"}
                  type="button"
                  disabled={pictureInPictureDisabled}
                />
              }
            >
              <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
      </form>
      {listVisible ? (
        <AddressBarSuggestionList
          id={listId}
          anchor={anchor}
          rows={rows}
          selectedIndex={activeIndex}
          onAccept={accept}
          onRemove={remove}
        />
      ) : null}
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
