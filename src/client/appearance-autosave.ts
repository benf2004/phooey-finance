import type { TransactionAppearance } from "../shared/transaction-appearance";

export type AppearanceSaveState = {
  status: "idle" | "saving" | "saved" | "error";
  error: string | null;
};

// App-owned so queued writes survive navigation away from Settings.
export function createAppearanceAutosave(
  save: (value: TransactionAppearance) => Promise<unknown>,
  show: (value: TransactionAppearance) => void,
) {
  let state: AppearanceSaveState = { status: "idle", error: null };
  let latest: { version: number; value: TransactionAppearance } | null = null;
  let completed = 0;
  let running = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(next: AppearanceSaveState) {
    state = next;
    listeners.forEach((listener) => listener());
  }
  async function flush() {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && latest && latest.version > completed) {
        const target = latest;
        try {
          await save(target.value);
        } catch (error) {
          if (disposed) return;
          // A newer selection supersedes a failed older request too.
          if (latest.version !== target.version) continue;
          publish({
            status: "error",
            error: error instanceof Error ? error.message : "Please try again.",
          });
          return;
        }
        if (disposed) return;
        completed = target.version;
        if (latest.version === completed)
          publish({ status: "saved", error: null });
      }
    } finally {
      running = false;
    }
  }
  return {
    change(value: TransactionAppearance) {
      if (disposed) return;
      latest = { version: (latest?.version ?? 0) + 1, value: { ...value } };
      show(latest.value);
      publish({ status: "saving", error: null });
      void flush();
    },
    retry() {
      if (disposed || !latest || running) return;
      publish({ status: "saving", error: null });
      void flush();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
