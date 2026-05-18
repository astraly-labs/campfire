import { create } from "zustand";

export interface FilePreviewTarget {
  readonly cwd: string;
  readonly filePath: string;
}

interface FilePreviewStore {
  readonly current: FilePreviewTarget | null;
  readonly open: (target: FilePreviewTarget) => void;
  readonly close: () => void;
}

export const useFilePreviewStore = create<FilePreviewStore>((set) => ({
  current: null,
  open: (target) => set({ current: target }),
  close: () => set({ current: null }),
}));
