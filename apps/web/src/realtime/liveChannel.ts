import { useEffect } from "react";

import { realtimeLog } from "../rpc/realtimeLog";

export interface LiveChannelSubscribeOptions {
  readonly onResubscribe?: () => void;
}

export type LiveChannelSubscribe<TEvent> = (
  listener: (event: TEvent) => void,
  options: LiveChannelSubscribeOptions,
) => () => void;

export interface LiveChannelParams<TEvent> {
  readonly channelKey: string;
  readonly subscribe: LiveChannelSubscribe<TEvent>;
  readonly applyEvent: (event: TEvent) => void;
  readonly onResubscribe?: () => void | Promise<void>;
}

export function attachLiveChannel<TEvent>(params: LiveChannelParams<TEvent>): () => void {
  const { channelKey, subscribe, applyEvent, onResubscribe } = params;
  realtimeLog(channelKey, "channel.attach");
  const unsubscribe = subscribe(applyEvent, {
    onResubscribe: () => {
      realtimeLog(channelKey, "channel.resubscribed");
      if (!onResubscribe) return;
      try {
        const result = onResubscribe();
        if (result instanceof Promise) {
          result.catch((error) => {
            realtimeLog(channelKey, "channel.resubscribe-callback-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } catch (error) {
        realtimeLog(channelKey, "channel.resubscribe-callback-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  return () => {
    realtimeLog(channelKey, "channel.detach");
    unsubscribe();
  };
}

export function useLiveChannel<TEvent>(
  setup: () => LiveChannelParams<TEvent> | null,
  deps: ReadonlyArray<unknown>,
): void {
  useEffect(() => {
    const params = setup();
    if (!params) return;
    return attachLiveChannel(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
