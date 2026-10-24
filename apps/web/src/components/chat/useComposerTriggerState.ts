import { useCallback, useRef, useState } from "react";

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

  const resolveTrigger = useCallback((candidate: Trigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  }, []);

  const setTrigger = useCallback(
    (candidate: Trigger | null) => {
      const activeTrigger = resolveTrigger(candidate);
      if (candidate === null || activeTrigger !== null) {
        dismissedTriggerRef.current = null;
      }
      setActiveTrigger(activeTrigger);
    },
    [resolveTrigger],
  );

  const dismissTrigger = useCallback((candidate: Trigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  }, []);

  const resetTrigger = useCallback((candidate: Trigger | null) => {
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  }, []);

  return { trigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
