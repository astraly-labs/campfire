import { create } from "zustand";

import {
  buildFileTree,
  fetchWorkspaceFilesTree,
  type TreeDirectoryNode,
} from "./workspaceFileTree";

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface CwdSnapshot {
  readonly paths: readonly string[];
  readonly tree: TreeDirectoryNode;
  readonly truncated: boolean;
  readonly supported: boolean;
  readonly fetchedAt: number;
}

interface WorkspaceFileTreeState {
  readonly open: boolean;
  readonly cwd: string | null;
  readonly status: LoadStatus;
  readonly error: string | null;
  readonly snapshot: CwdSnapshot | null;
  readonly openDrawer: (cwd: string) => void;
  readonly closeDrawer: () => void;
  readonly refresh: () => Promise<void>;
}

// Cache by cwd so reopening the drawer on the same project is instant. The
// server already caches `git ls-files` for ~15s; this avoids the network round
// trip entirely between opens.
const cache = new Map<string, CwdSnapshot>();
const STALE_AFTER_MS = 30_000;
let activeFetch: { cwd: string; controller: AbortController } | null = null;

export const useWorkspaceFileTreeStore = create<WorkspaceFileTreeState>((set, get) => {
  const loadFor = async (cwd: string, force: boolean) => {
    const cached = cache.get(cwd);
    if (!force && cached && Date.now() - cached.fetchedAt < STALE_AFTER_MS) {
      set({ status: "ready", error: null, snapshot: cached });
      return;
    }

    if (activeFetch && activeFetch.cwd !== cwd) {
      activeFetch.controller.abort();
    }
    const controller = new AbortController();
    activeFetch = { cwd, controller };
    set({ status: "loading", error: null });

    try {
      const result = await fetchWorkspaceFilesTree(cwd, controller.signal);
      if (controller.signal.aborted) return;
      const snapshot: CwdSnapshot = {
        paths: result.paths,
        tree: buildFileTree(result.paths),
        truncated: result.truncated,
        supported: result.supported,
        fetchedAt: Date.now(),
      };
      cache.set(cwd, snapshot);
      if (get().cwd !== cwd) return;
      set({ status: "ready", error: null, snapshot });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Failed to load files";
      if (get().cwd !== cwd) return;
      set({ status: "error", error: message });
    } finally {
      if (activeFetch?.controller === controller) activeFetch = null;
    }
  };

  return {
    open: false,
    cwd: null,
    status: "idle",
    error: null,
    snapshot: null,
    openDrawer: (cwd) => {
      const current = get();
      if (current.open && current.cwd === cwd) return;
      const cached = cache.get(cwd) ?? null;
      set({
        open: true,
        cwd,
        snapshot: cached,
        status: cached ? "ready" : "loading",
        error: null,
      });
      void loadFor(cwd, false);
    },
    closeDrawer: () => {
      if (activeFetch) {
        activeFetch.controller.abort();
        activeFetch = null;
      }
      set({ open: false });
    },
    refresh: async () => {
      const { cwd } = get();
      if (!cwd) return;
      await loadFor(cwd, true);
    },
  };
});
