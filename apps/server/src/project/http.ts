import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectMutationOperation } from "./ProjectMutation.ts";
import { withAuthenticatedCollaboration } from "../auth/collaboration.ts";

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause:
    | ProjectService.ProjectServiceError
    | ServerRuntimeStartup.ServerRuntimeStartupError
    | ServerRuntimeStartup.ServerCommandOverloadedError,
) {
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  if (cause._tag === "ServerCommandOverloadedError") {
    return yield* failEnvironmentInternal("command_overloaded", cause);
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.snapshot.pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          for (const scope of requiredScopesForProjectMutation(args.payload)) {
            yield* requireEnvironmentScope(scope);
          }
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const operation = projectMutationOperation(projects, withAuthenticatedCollaboration(args.payload, principal));
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      );
  }),
);
