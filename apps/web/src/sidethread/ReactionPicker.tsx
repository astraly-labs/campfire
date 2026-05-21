import type { ReactElement } from "react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

/**
 * Curated quick-reaction set. We deliberately keep the V1 picker tiny —
 * Telegram and Slack both surface a "frequently used" row first and only
 * expand to the full emoji catalogue behind a second click. We can layer
 * an emoji-mart based full picker later without changing this API.
 */
const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🔥", "🚀", "👀", "🙏", "😢", "😮"] as const;

interface Props {
  readonly trigger: ReactElement;
  readonly onPick: (emoji: string) => void;
}

export function ReactionPicker({ trigger, onPick }: Props) {
  // Controlled so we can dismiss after a pick. Uncontrolled would leave
  // the popover open and require a second click to react again.
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="!p-0 [&>[data-slot=popover-viewport]]:!p-0"
      >
        <div className="flex items-center gap-0.5 px-2 py-1.5">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
              aria-label={`React with ${emoji}`}
              className="grid size-7 place-items-center rounded-md text-base leading-none transition-transform hover:scale-125 hover:bg-accent active:scale-110"
            >
              <span>{emoji}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
