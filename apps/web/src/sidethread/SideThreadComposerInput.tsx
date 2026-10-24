import type { CollaborationUser, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "../components/chat/ComposerCommandMenu";
import {
  nudgeComposerMenuItemId,
  resolveComposerMenuActiveItemId,
} from "../components/chat/composerMenuHighlight";
import { useComposerTriggerState } from "../components/chat/useComposerTriggerState";
import { extendReplacementRangeForTrailingSpace, replaceTextRange } from "../composer-logic";
import { useTheme } from "../hooks/useTheme";
import { useThreadShells } from "../state/entities";
import {
  detectSideThreadTrigger,
  matchMentionItems,
  matchThreadLinkItems,
  suggestionToken,
  type PickedThreadLink,
  type SideThreadSuggestionItem,
  type SideThreadTrigger,
} from "./sideThreadComposerTriggers";

const MENU_COPY = {
  mention: { listLabel: "Teammates", emptyState: "No matching teammates." },
  thread: { listLabel: "Agent threads", emptyState: "No matching active agent threads." },
} as const;

/** The side-thread textarea, with `@` teammate and `#` agent-thread suggestions. */
export function SideThreadComposerInput(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Off while editing a sent message: an edit cannot change its mentions or link. */
  readonly suggestionsEnabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly team: ReadonlyArray<CollaborationUser>;
  readonly currentSubject: string | null;
  readonly onThreadLinkPicked: (link: PickedThreadLink) => void;
}) {
  const { value, onValueChange, onSubmit, environmentId, threadId, team, currentSubject } = props;
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { resolvedTheme } = useTheme();
  const [focused, setFocused] = useState(false);
  const { trigger, setTrigger, dismissTrigger } = useComposerTriggerState<SideThreadTrigger>(
    () => null,
  );
  const [highlight, setHighlight] = useState<{
    readonly itemId: string | null;
    readonly searchKey: string | null;
  }>({ itemId: null, searchKey: null });

  const activeTrigger = props.suggestionsEnabled && focused ? trigger : null;
  // Subscribe to every thread shell only while the `#` menu needs them.
  const threads = useThreadShells(activeTrigger?.kind === "thread");
  const items = useMemo<SideThreadSuggestionItem[]>(() => {
    if (activeTrigger === null) return [];
    return activeTrigger.kind === "mention"
      ? matchMentionItems({ team, currentSubject, query: activeTrigger.query })
      : matchThreadLinkItems({
          threads,
          environmentId,
          excludeThreadId: threadId,
          query: activeTrigger.query,
        });
  }, [activeTrigger, currentSubject, environmentId, team, threadId, threads]);
  const searchKey = activeTrigger ? `${activeTrigger.kind}:${activeTrigger.query}` : null;
  const activeItemId = resolveComposerMenuActiveItemId({
    items,
    highlightedItemId: highlight.itemId,
    currentSearchKey: searchKey,
    highlightedSearchKey: highlight.searchKey,
  });

  const syncTrigger = (textarea: HTMLTextAreaElement) => {
    setTrigger(
      textarea.selectionStart === textarea.selectionEnd
        ? detectSideThreadTrigger(textarea.value, textarea.selectionStart)
        : null,
    );
  };

  const pick = (item: ComposerCommandItem) => {
    const textarea = textareaRef.current;
    if (!activeTrigger || !textarea || (item.type !== "mention" && item.type !== "thread")) return;
    const replacement = suggestionToken(item);
    const next = replaceTextRange(
      value,
      activeTrigger.rangeStart,
      extendReplacementRangeForTrailingSpace(value, activeTrigger.rangeEnd, replacement),
      replacement,
    );
    if (item.type === "thread") {
      props.onThreadLinkPicked({ threadId: item.thread.threadId, title: item.label });
    }
    // Commit the text before moving the caret, or React resets it on the next render.
    flushSync(() => onValueChange(next.text));
    textarea.focus();
    textarea.setSelectionRange(next.cursor, next.cursor);
    setTrigger(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (activeTrigger && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        // The sheet closes on an Escape that reaches the document.
        event.stopPropagation();
        dismissTrigger(activeTrigger);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length > 0) {
        event.preventDefault();
        setHighlight({
          itemId: nudgeComposerMenuItemId(items, activeItemId, event.key),
          searchKey,
        });
        return;
      }
      const activeItem = items.find((item) => item.id === activeItemId);
      const picks =
        (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) ||
        (event.key === "Tab" && !event.shiftKey);
      if (activeItem && picks) {
        event.preventDefault();
        pick(activeItem);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setTrigger(null);
      onSubmit();
    }
  };

  return (
    <div className="relative">
      {activeTrigger ? (
        // Tucked behind the textarea's top edge like the agent composer's menu drawer.
        <div className="absolute inset-x-3 bottom-full z-10 -mb-[calc(1rem+1px)]">
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind={null}
            listLabel={MENU_COPY[activeTrigger.kind].listLabel}
            emptyStateText={MENU_COPY[activeTrigger.kind].emptyState}
            activeItemId={activeItemId}
            onHighlightedItemChange={(itemId) => setHighlight({ itemId, searchKey })}
            onSelect={pick}
          />
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          syncTrigger(event.target);
        }}
        onSelect={(event) => syncTrigger(event.currentTarget)}
        onFocus={(event) => {
          setFocused(true);
          syncTrigger(event.currentTarget);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        aria-controls={activeTrigger && items.length > 0 ? listId : undefined}
        aria-activedescendant={
          activeTrigger && activeItemId
            ? composerSuggestionOptionId(listId, activeItemId)
            : undefined
        }
        maxLength={20_000}
        rows={4}
        placeholder="Write to the team… @ to mention, # to link a thread"
        className="relative z-20 w-full resize-none rounded-xl border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
      />
    </div>
  );
}
