/**
 * UserDirectoryService — exposes the list of users known to the backend.
 *
 * Sourced from the `users` table that `UserIdentityService` upserts on
 * Tailscale pairing. Powers `@`-autocomplete in the side-thread composer.
 *
 * @module UserDirectoryService
 */
import type { UserRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface UserDirectoryShape {
  readonly listUsers: () => Effect.Effect<ReadonlyArray<UserRef>, ProjectionRepositoryError>;
}

export class UserDirectoryService extends Context.Service<
  UserDirectoryService,
  UserDirectoryShape
>()("t3/sidethreads/Services/UserDirectory/UserDirectoryService") {}
