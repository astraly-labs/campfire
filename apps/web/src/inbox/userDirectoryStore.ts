/**
 * User directory store — caches the list of {@link UserRef}s known to the
 * backend. Drives the `@`-autocomplete in the side-thread composer.
 *
 * One fetch per page load is enough for the v1 (handful of users on a
 * tailnet). If we ever need refresh semantics we can subscribe to a
 * `users.directoryUpdated` stream.
 */
import type { EnvironmentApi, UserRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

interface UserDirectoryStore {
  readonly users: ReadonlyArray<UserRef>;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly errorMessage: string | null;
  readonly ensureLoaded: (api: EnvironmentApi) => Promise<void>;
  readonly reset: () => void;
}

let pendingLoad: Promise<void> | null = null;

export const useUserDirectoryStore = create<UserDirectoryStore>((set, get) => ({
  users: [],
  status: "idle",
  errorMessage: null,

  ensureLoaded: async (api) => {
    if (get().status === "ready") return;
    if (pendingLoad) {
      await pendingLoad;
      return;
    }
    pendingLoad = (async () => {
      set({ status: "loading", errorMessage: null });
      try {
        const result = await api.users.directory();
        set({ users: result.users, status: "ready", errorMessage: null });
      } catch (cause) {
        set({
          status: "error",
          errorMessage: cause instanceof Error ? cause.message : "Failed to load user directory",
        });
      }
    })();
    try {
      await pendingLoad;
    } finally {
      pendingLoad = null;
    }
  },

  reset: () => set({ users: [], status: "idle", errorMessage: null }),
}));

export function useEnsureUserDirectoryLoaded(api: EnvironmentApi | undefined): void {
  useEffect(() => {
    if (!api) return;
    void useUserDirectoryStore.getState().ensureLoaded(api);
  }, [api]);
}

// Lowercase + strip combining diacritics so `mathéo` matches the query
// `matheo` and vice-versa. Matches the slug behaviour of
// `mentionHandleForUser`, which is what users see in the rendered token.
const folded = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Pure, exported for testing. Returns up to `limit` users whose display name
 * starts with the query, then those that contain it. Comparison is
 * case-insensitive AND diacritic-insensitive.
 */
export function filterUsersForMention(
  users: ReadonlyArray<UserRef>,
  query: string,
  limit = 8,
): ReadonlyArray<UserRef> {
  const normalized = folded(query.trim());
  if (normalized.length === 0) return users.slice(0, limit);
  const starts: UserRef[] = [];
  const contains: UserRef[] = [];
  for (const user of users) {
    const folded_name = folded(user.displayName);
    if (folded_name.startsWith(normalized)) starts.push(user);
    else if (folded_name.includes(normalized)) contains.push(user);
  }
  return [...starts, ...contains].slice(0, limit);
}
