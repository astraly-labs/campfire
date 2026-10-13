import { createPresenceEnvironmentAtoms } from "@t3tools/client-runtime/state/presence";

import { connectionAtomRuntime } from "../connection/runtime";

export const presenceEnvironment = createPresenceEnvironmentAtoms(connectionAtomRuntime);
