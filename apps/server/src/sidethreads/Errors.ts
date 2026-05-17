import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class SideThreadCommandInvariantError extends Schema.TaggedErrorClass<SideThreadCommandInvariantError>()(
  "SideThreadCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SideThread command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class SideThreadProjectorDecodeError extends Schema.TaggedErrorClass<SideThreadProjectorDecodeError>()(
  "SideThreadProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SideThread projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export type SideThreadDispatchError =
  | ProjectionRepositoryError
  | SideThreadCommandInvariantError
  | SideThreadProjectorDecodeError;

export class UserIdentityWhoisError extends Schema.TaggedErrorClass<UserIdentityWhoisError>()(
  "UserIdentityWhoisError",
  {
    tailnetIp: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `tailscale whois failed for ${this.tailnetIp}: ${this.detail}`;
  }
}

export class UserIdentityDecodeError extends Schema.TaggedErrorClass<UserIdentityDecodeError>()(
  "UserIdentityDecodeError",
  {
    tailnetIp: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to decode tailscale whois output for ${this.tailnetIp}: ${this.issue}`;
  }
}

export type UserIdentityError =
  | UserIdentityWhoisError
  | UserIdentityDecodeError
  | ProjectionRepositoryError;

export function toSideThreadProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): SideThreadProjectorDecodeError =>
    new SideThreadProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
