import { PRESENCE_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPresenceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const heartbeatScheduler = createAtomCommandScheduler();
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:presence:snapshot",
      tag: PRESENCE_WS_METHODS.subscribe,
    }),
    heartbeat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:presence:heartbeat",
      tag: PRESENCE_WS_METHODS.heartbeat,
      scheduler: heartbeatScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
