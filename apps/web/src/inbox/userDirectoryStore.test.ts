import { describe, expect, it } from "vitest";

import type { UserRef } from "@t3tools/contracts";

import { filterUsersForMention } from "./userDirectoryStore";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserRef["id"],
  displayName: displayName as UserRef["displayName"],
});

const ALICE = mkUser("u-alice", "Alice");
const BOB = mkUser("u-bob", "Bob");
const ALICIA = mkUser("u-alicia", "Alicia");
const CHARLIE = mkUser("u-charlie", "Charlie Alice");

describe("filterUsersForMention", () => {
  const users = [ALICE, BOB, ALICIA, CHARLIE];

  it("returns the directory unfiltered when query is empty", () => {
    expect(filterUsersForMention(users, "")).toEqual(users);
  });

  it("ranks prefix matches before substring matches", () => {
    const result = filterUsersForMention(users, "ali");
    expect(result).toEqual([ALICE, ALICIA, CHARLIE]);
  });

  it("is case-insensitive", () => {
    expect(filterUsersForMention(users, "BOB")).toEqual([BOB]);
  });

  it("respects the limit", () => {
    expect(filterUsersForMention(users, "", 2)).toEqual([ALICE, BOB]);
  });

  it("ignores diacritics on both query and target", () => {
    const matheo = mkUser("u-matheo", "Mathéo");
    expect(filterUsersForMention([matheo], "matheo")).toEqual([matheo]);
    expect(filterUsersForMention([matheo], "mathéo")).toEqual([matheo]);
    const elise = mkUser("u-elise", "Élise");
    expect(filterUsersForMention([elise], "el")).toEqual([elise]);
  });
});
