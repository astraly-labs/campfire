import {
  type ContextAssistantAskInput,
  type ContextAssistantStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

export interface ContextAssistantAskCommandInput extends ContextAssistantAskInput {
  readonly onEvent: (event: ContextAssistantStreamEvent) => void;
}

export function createContextAssistantEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const sessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly sessionId: string };
  }) => JSON.stringify([environmentId, input.sessionId]);

  return {
    ask: createEnvironmentCommand(runtime, {
      label: "environment-data:context-assistant:ask",
      scheduler,
      concurrency: { mode: "serial", key: sessionKey },
      execute: (input: ContextAssistantAskCommandInput) =>
        runStream(WS_METHODS.contextAssistantAsk, {
          sessionId: input.sessionId,
          sourceThreadId: input.sourceThreadId,
          prompt: input.prompt,
        }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              input.onEvent(event);
            }),
          ),
        ),
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:context-assistant:close",
      tag: WS_METHODS.contextAssistantClose,
    }),
  };
}
