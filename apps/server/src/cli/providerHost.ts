import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig } from "../config.ts";
import { runCodexProviderHost } from "../provider/host/CodexProviderHost.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const providerHostCommand = Command.make("provider-host", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription(
    "Run the long-lived Codex provider host independently from the web server.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      const path = yield* Path.Path;
      const socketPath =
        process.env.T3CODE_CODEX_HOST_SOCKET?.trim() ||
        path.join(config.baseDir, "runtime", "codex-provider-host.sock");
      return yield* runCodexProviderHost(config, socketPath).pipe(
        Effect.provideService(ServerConfig, config),
      );
    }),
  ),
);
