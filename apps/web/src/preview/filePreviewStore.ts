import { create } from "zustand";

export interface FilePreviewTarget {
  readonly cwd: string;
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
}

const SHOW_LINE_NUMBERS_STORAGE_KEY = "t3code:file-preview:show-line-numbers";

function readPersistedShowLineNumbers(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SHOW_LINE_NUMBERS_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

function persistShowLineNumbers(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHOW_LINE_NUMBERS_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

interface FilePreviewStore {
  readonly current: FilePreviewTarget | null;
  readonly showLineNumbers: boolean;
  readonly open: (target: FilePreviewTarget) => void;
  readonly close: () => void;
  readonly setShowLineNumbers: (value: boolean) => void;
  readonly toggleShowLineNumbers: () => void;
}

export const useFilePreviewStore = create<FilePreviewStore>((set, get) => ({
  current: null,
  showLineNumbers: readPersistedShowLineNumbers(),
  open: (target) => set({ current: target }),
  close: () => set({ current: null }),
  setShowLineNumbers: (value) => {
    persistShowLineNumbers(value);
    set({ showLineNumbers: value });
  },
  toggleShowLineNumbers: () => {
    const next = !get().showLineNumbers;
    persistShowLineNumbers(next);
    set({ showLineNumbers: next });
  },
}));
