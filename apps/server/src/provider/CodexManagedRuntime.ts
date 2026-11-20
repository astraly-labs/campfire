import { managedCodexHomePath, resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { COMMAND_TIMEOUT_MS } from "./CodexManagedTokenProtocol.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const MANAGED_TOKEN_COMMAND = "__managed-chatgpt-token";
export const managedCodexLaunchArgs = (command: string, args: ReadonlyArray<string>) =>
  [
    'model_provider="openai_token_sharing"',
    // Codex persists this provider ID in rollouts and needs it unchanged to resume.
    `model_providers.openai_token_sharing={name="OpenAI Token Sharing",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(command)},args=${JSON.stringify(args)},timeout_ms=${COMMAND_TIMEOUT_MS},refresh_interval_ms=0}}`,
    "features.api_key_model_discovery=true",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");

const decodeConfigValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
const decodeTokenCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
);
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const CONFIG_VALUE = new RegExp(String.raw`-c (${JSON_STRING})`, "gu");
const TOKEN_COMMAND = new RegExp(
  String.raw`auth=\{command=(${JSON_STRING}),args=(\[(?:${JSON_STRING},?)*\]),`,
  "u",
);
// Only the exact arguments that managedCodexLaunchArgs builds route a login through the broker.
const managedTokenArgs = (launchArgs: string) => {
  const provider = Array.from(launchArgs.matchAll(CONFIG_VALUE), ([, value]) =>
    Option.getOrUndefined(decodeConfigValue(value)),
  )[1];
  const match = provider === undefined ? null : TOKEN_COMMAND.exec(provider);
  const command = match ? decodeTokenCommand(`[${match[1]},${match[2]}]`) : Option.none();
  return Option.isSome(command) && managedCodexLaunchArgs(...command.value) === launchArgs
    ? command.value[1]
    : undefined;
};
const LOGIN_OVERRIDES = [
  "ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "T3CODE_CODEX_LAUNCH_ARGS",
];

/** Why a runtime cannot run a managed instance, or undefined when it only uses that instance's own login. */
export const managedCodexRuntimeProblem = (
  expected: { readonly instanceId: ProviderInstanceId; readonly homePath: string },
  runtime: CodexEffectiveRuntime,
): string | undefined => {
  if (runtime.config.setupMode !== "managed")
    return `Codex instance ${expected.instanceId} received a runtime that is not managed.`;
  if (
    runtime.config.homePath !== expected.homePath ||
    runtime.environment.CODEX_HOME !== expected.homePath
  )
    return `Managed Codex instance ${expected.instanceId} runs only with its own Codex home ${expected.homePath}.`;
  const override = LOGIN_OVERRIDES.find((name) => runtime.environment[name] !== undefined);
  if (override !== undefined)
    return `The managed Codex runtime sets ${override}, which can move Codex to another login.`;
  // The self-invocation entrypoint, if any, precedes the token command and its four arguments.
  const args = managedTokenArgs(runtime.config.launchArgs) ?? [];
  const [command, , instanceId, , profileKey] = args.slice(-5);
  if (
    args.length > 6 ||
    command !== MANAGED_TOKEN_COMMAND ||
    instanceId !== expected.instanceId ||
    profileKey !== runtime.revision
  )
    return `Managed Codex instance ${expected.instanceId} must get its login from the T3 token broker for this instance and its signed-in profile.`;
  return undefined;
};

export const makeCodexManagedRuntime = Effect.fn("makeCodexManagedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings;
}) {
  const installation = yield* CodexInstallation.CodexInstallation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environmentIdentity.getEnvironmentId;
  const invocation = yield* resolveSelfInvocation();
  const auth = yield* makeCodexChatGptAuth({
    instanceId: options.instanceId,
    defaultReturnUrl: new URL(
      "/welcome",
      config.devUrl ?? `http://localhost:${config.port}`,
    ).toString(),
  });
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    config.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = managedCodexHomePath(homeLayout);
  const resolve = Effect.gen(function* () {
    // Establish renewal availability before auth.access can consume a refresh token.
    const endpoint = yield* broker.endpoint.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail:
              "Could not prepare the private managed Codex token listener. Restart T3 and retry.",
            cause,
          }),
      ),
    );
    const executable = yield* installation.acquire().pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "install",
            detail: "Set up managed Codex before starting a session.",
          }),
      ),
    );
    const credentials = yield* auth.access;
    const profileKey = yield* auth.profileKey(credentials);
    const authArgs = selfInvocationArgs(invocation, [
      MANAGED_TOKEN_COMMAND,
      endpoint,
      options.instanceId,
      environmentId,
      profileKey,
    ]);
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: cause.message,
          }),
      ),
    );
    yield* fs.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the managed Codex runtime.",
          }),
      ),
    );
    // Ambient CLI overrides cannot redirect a T3-owned token to a different provider.
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      CODEX_HOME: homePath,
    };
    delete environment.ACCESS_TOKEN;
    delete environment.T3CODE_CODEX_LAUNCH_ARGS;
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    return {
      config: decodeSettings({
        enabled: options.enabled,
        setupMode: "managed",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: managedCodexLaunchArgs(invocation.command, authArgs),
      }),
      environment,
      revision: profileKey,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});
