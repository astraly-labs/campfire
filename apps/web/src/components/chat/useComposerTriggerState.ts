import { useRef, useState } from "react";

interface DismissibleTrigger {
  readonly kind: string;
  readonly rangeStart: number;
}

/** Keep a dismissed suggestion closed until the caret leaves its token. */
export function useComposerTriggerState<Trigger extends DismissibleTrigger>(
  initialTrigger: () => Trigger | null,
) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  const dismissedTriggerRef = useRef<Trigger | null>(null);

  const resolveTrigger = (candidate: Trigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  };

  const setTrigger = (candidate: Trigger | null) => {
    const activeTrigger = resolveTrigger(candidate);
    if (candidate === null || activeTrigger !== null) {
      dismissedTriggerRef.current = null;
    }
    setActiveTrigger(activeTrigger);
  };

  const dismissTrigger = (candidate: Trigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  };

  const resetTrigger = (candidate: Trigger | null) => {
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  };

  return { trigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
