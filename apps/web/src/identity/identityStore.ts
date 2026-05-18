import type { EnvironmentApi, IdentityCurrentUser, UserRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

const LEGACY_LOCALSTORAGE_KEY = "campfire.sidethread.userRef.v1";

/**
 * Pre-server-resolution identity used during the brief window between mount
 * and the first `identity.getCurrentUser` round-trip. Holding null and
 * having callers wait avoids racy posts with an empty author.
 */
export type IdentityState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: IdentityCurrentUser }
  | { readonly kind: "error"; readonly message: string };

interface IdentityStore {
  readonly state: IdentityState;
  readonly load: (api: EnvironmentApi) => Promise<void>;
  readonly ensureLoaded: (api: EnvironmentApi) => Promise<void>;
  readonly setDisplayName: (api: EnvironmentApi, displayName: string) => Promise<void>;
  readonly clearDisplayName: (api: EnvironmentApi) => Promise<void>;
  readonly reset: () => void;
}

let pendingLoad: Promise<void> | null = null;

export const useIdentityStore = create<IdentityStore>((set, get) => ({
  state: { kind: "loading" },

  load: async (api) => {
    try {
      const result = await api.identity.getCurrentUser();
      set({ state: { kind: "ready", result } });
      purgeLegacyLocalStorage();
    } catch (cause) {
      set({
        state: {
          kind: "error",
          message: cause instanceof Error ? cause.message : "Failed to resolve identity",
        },
      });
    }
  },

  ensureLoaded: async (api) => {
    const current = get().state;
    if (current.kind === "ready") return;
    if (pendingLoad) {
      await pendingLoad;
      return;
    }
    pendingLoad = get().load(api);
    try {
      await pendingLoad;
    } finally {
      pendingLoad = null;
    }
  },

  setDisplayName: async (api, displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    const result = await api.identity.setDisplayName({ displayName: trimmed });
    set({ state: { kind: "ready", result } });
  },

  clearDisplayName: async (api) => {
    const result = await api.identity.clearDisplayName();
    set({ state: { kind: "ready", result } });
  },

  reset: () => set({ state: { kind: "loading" } }),
}));

/**
 * Read-only hook for components that just need the effective `UserRef`
 * (composer authors, side-thread message rows). Returns `null` while the
 * first resolve is in flight or if it failed.
 */
export function useCurrentUser(): UserRef | null {
  return useIdentityStore((store) =>
    store.state.kind === "ready" ? store.state.result.user : null,
  );
}

/**
 * Convenience hook for components that just want the identity loaded by the
 * time they render. Triggers a one-shot `ensureLoaded` against the environment
 * API. Safe to call from multiple components — the store coalesces concurrent
 * loads.
 */
export function useEnsureIdentityLoaded(api: EnvironmentApi): void {
  useEffect(() => {
    void useIdentityStore.getState().ensureLoaded(api);
  }, [api]);
}

function purgeLegacyLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode, SSR-like environment) —
    // best-effort, never block the UI on cleanup.
  }
}
