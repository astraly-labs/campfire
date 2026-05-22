import { assert, describe, it } from "@effect/vitest";

import type { UserId } from "@t3tools/contracts";

import type { ResolvedIdentity } from "../sidethreads/Services/UserIdentity.ts";

import { resolvedIdentityToGitAuthor } from "./commitIdentity.ts";

const identity = (input: {
  readonly id: string;
  readonly displayName: string;
  readonly source?: ResolvedIdentity["source"];
}): ResolvedIdentity => ({
  user: { id: input.id as unknown as UserId, displayName: input.displayName },
  canonicalDisplayName: input.displayName,
  source: input.source ?? "tailscale-whois",
  hasOverride: false,
});

describe("resolvedIdentityToGitAuthor", () => {
  it("uses the Tailscale login as email when the UserId looks like an email", () => {
    const author = resolvedIdentityToGitAuthor(
      identity({ id: "alice@pragma.build", displayName: "Alice Smith" }),
    );
    assert.deepStrictEqual(author, { name: "Alice Smith", email: "alice@pragma.build" });
  });

  it("falls back to a noreply email for the local fallback identity", () => {
    const author = resolvedIdentityToGitAuthor(
      identity({ id: "local:matthias", displayName: "matthias", source: "local-fallback" }),
    );
    assert.deepStrictEqual(author, {
      name: "matthias",
      email: "matthias@users.noreply.github.com",
    });
  });

  it("slugifies spaces and accents into the noreply email local part", () => {
    const author = resolvedIdentityToGitAuthor(
      identity({ id: "local:bob", displayName: "Étienne O'Connor", source: "local-fallback" }),
    );
    assert.deepStrictEqual(author, {
      name: "Étienne O'Connor",
      email: "etienne-o-connor@users.noreply.github.com",
    });
  });

  it("defaults to anonymous when the display name is empty whitespace", () => {
    const author = resolvedIdentityToGitAuthor(
      identity({ id: "local:   ", displayName: "   ", source: "local-fallback" }),
    );
    assert.deepStrictEqual(author, {
      name: "anonymous",
      email: "anonymous@users.noreply.github.com",
    });
  });

  it("keeps the email-style UserId even when the display name is empty", () => {
    const author = resolvedIdentityToGitAuthor(
      identity({ id: "carol@pragma.build", displayName: "   " }),
    );
    assert.deepStrictEqual(author, {
      name: "anonymous",
      email: "carol@pragma.build",
    });
  });
});
