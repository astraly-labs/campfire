import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface SideThreadUiState {
  readonly requestedThreadKey: string | null;
  readonly requestOpen: (threadRef: ScopedThreadRef) => void;
  readonly consumeOpenRequest: (threadKey: string) => void;
}

export const useSideThreadUiStore = create<SideThreadUiState>((set) => ({
  requestedThreadKey: null,
  requestOpen: (threadRef) => set({ requestedThreadKey: scopedThreadKey(threadRef) }),
  consumeOpenRequest: (threadKey) =>
    set((state) => (state.requestedThreadKey === threadKey ? { requestedThreadKey: null } : state)),
}));
