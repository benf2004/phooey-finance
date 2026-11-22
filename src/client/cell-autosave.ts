/** One cell commit may be triggered by blur, a click, and Tab in the same frame. */
export function createCellAutosave() {
  let pending: Promise<boolean> | null = null;
  return {
    get pending() {
      return pending;
    },
    save(
      write: () => Promise<void>,
      events: {
        saved: () => void;
        failed: (error: unknown) => void;
        settled: () => void;
      },
    ): Promise<boolean> {
      if (pending) return pending;
      // Defer invoking write: synchronous validation failures must release the
      // same lock as rejected requests so the retained draft can be corrected.
      pending = Promise.resolve()
        .then(write)
        .then(
          () => {
            events.saved();
            return true;
          },
          (error) => {
            events.failed(error);
            return false;
          },
        )
        .finally(() => {
          pending = null;
          events.settled();
        });
      return pending;
    },
  };
}
