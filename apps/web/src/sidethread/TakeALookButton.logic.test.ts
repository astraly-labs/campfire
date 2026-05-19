import type { UserId, UserRef } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  pingedToastTitle,
  selectTakeALookCandidates,
  selectedTargetsInOrder,
  sendButtonLabel,
  toggleSelection,
} from "./TakeALookButton.logic";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserRef["id"],
  displayName: displayName as UserRef["displayName"],
});

const ALICE = mkUser("user-alice", "Alice");
const BOB = mkUser("user-bob", "Bob");
const CARL = mkUser("user-carl", "Carl");
const SELF = mkUser("user-self", "Self");

describe("selectTakeALookCandidates", () => {
  it("excludes the current user", () => {
    expect(selectTakeALookCandidates([SELF, ALICE, BOB], SELF.id)).toEqual([ALICE, BOB]);
  });

  it("returns everyone when the current user is unknown (loading state)", () => {
    expect(selectTakeALookCandidates([ALICE, BOB], null)).toEqual([ALICE, BOB]);
  });

  it("returns an empty list when only the current user is present", () => {
    expect(selectTakeALookCandidates([SELF], SELF.id)).toEqual([]);
  });
});

describe("toggleSelection", () => {
  it("adds a user when absent", () => {
    const next = toggleSelection(new Set<UserId>(), ALICE.id);
    expect(Array.from(next)).toEqual([ALICE.id]);
  });

  it("removes a user when already present", () => {
    const next = toggleSelection(new Set<UserId>([ALICE.id, BOB.id]), ALICE.id);
    expect([...next]).toEqual([BOB.id]);
  });

  it("returns a fresh Set instance to keep React updates referentially fresh", () => {
    const current = new Set<UserId>([ALICE.id]);
    const next = toggleSelection(current, BOB.id);
    expect(next).not.toBe(current);
  });
});

describe("selectedTargetsInOrder", () => {
  it("follows the candidate order, not the insertion order of the selection set", () => {
    const candidates = [ALICE, BOB, CARL];
    const selected = new Set<UserId>([CARL.id, ALICE.id]);
    expect(selectedTargetsInOrder(candidates, selected)).toEqual([ALICE, CARL]);
  });

  it("returns an empty list when nothing is selected", () => {
    expect(selectedTargetsInOrder([ALICE, BOB], new Set())).toEqual([]);
  });
});

describe("sendButtonLabel", () => {
  it("shows the bare label when nothing is selected", () => {
    expect(sendButtonLabel(0)).toBe("Send");
  });

  it("includes the count when at least one is selected", () => {
    expect(sendButtonLabel(1)).toBe("Send (1)");
    expect(sendButtonLabel(3)).toBe("Send (3)");
  });
});

describe("pingedToastTitle", () => {
  it("names the single recipient explicitly", () => {
    expect(pingedToastTitle([ALICE])).toBe("Pinged Alice");
  });

  it("uses the count phrasing for multiple recipients", () => {
    expect(pingedToastTitle([ALICE, BOB])).toBe("Pinged 2 teammates");
    expect(pingedToastTitle([ALICE, BOB, CARL])).toBe("Pinged 3 teammates");
  });
});
