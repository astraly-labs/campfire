import { createContextAssistantEnvironmentAtoms } from "@t3tools/client-runtime/state/context-assistant";

import { connectionAtomRuntime } from "../connection/runtime";

export const contextAssistantEnvironment =
  createContextAssistantEnvironmentAtoms(connectionAtomRuntime);
