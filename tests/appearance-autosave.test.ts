import { expect, it, vi } from "vitest";
import { createAppearanceAutosave } from "../src/client/appearance-autosave";

const normal = {
  negativeAmountColor: "normal" as const,
  showNegativeSign: true,
};
const red = { negativeAmountColor: "red" as const, showNegativeSign: true };
const hidden = { ...red, showNegativeSign: false };
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shows changes immediately and serializes/coalesces rapid writes to the latest choice", async () => {
  const first = deferred(),
    last = deferred();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise);
  const show = vi.fn();
  const controller = createAppearanceAutosave(save, show);
  controller.change(red);
  controller.change(hidden);
  controller.change(normal);
  expect(show.mock.calls.map(([value]) => value)).toEqual([
    red,
    hidden,
    normal,
  ]);
  expect(save.mock.calls).toEqual([[red]]);
  expect(controller.getSnapshot().status).toBe("saving");
  first.resolve(red);
  await vi.waitFor(() => expect(save.mock.calls).toEqual([[red], [normal]]));
  expect(show).toHaveBeenCalledTimes(3); // An older response never changes the UI.
  expect(controller.getSnapshot().status).toBe("saving");
  last.resolve(normal);
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("saved"));
});

it("retains the latest choice after a failure and retries the same value", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(hidden);
  const show = vi.fn();
  const controller = createAppearanceAutosave(save, show);
  controller.change(hidden);
  await vi.waitFor(() =>
    expect(controller.getSnapshot()).toEqual({
      status: "error",
      error: "Offline",
    }),
  );
  expect(show.mock.calls).toEqual([[hidden]]);
  controller.retry();
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("saved"));
  expect(save.mock.calls).toEqual([[hidden], [hidden]]);
});

it("continues with a newer choice after an obsolete request fails", async () => {
  const first = deferred();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(hidden);
  const controller = createAppearanceAutosave(save, vi.fn());
  controller.change(red);
  controller.change(hidden);
  first.reject(new Error("Obsolete failure"));
  await vi.waitFor(() =>
    expect(controller.getSnapshot()).toEqual({ status: "saved", error: null }),
  );
  expect(save.mock.calls).toEqual([[red], [hidden]]);
});

it("a new choice clears a failed save and is the value that gets persisted", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(normal);
  const controller = createAppearanceAutosave(save, vi.fn());
  controller.change(red);
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("error"));
  controller.change(normal);
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("saved"));
  expect(save.mock.calls).toEqual([[red], [normal]]);
});

it("stops queued writes after the owning session ends", async () => {
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise);
  const controller = createAppearanceAutosave(save, vi.fn());
  controller.change(red);
  controller.change(hidden);
  controller.dispose();
  first.resolve();
  await first.promise;
  await Promise.resolve();
  expect(save.mock.calls).toEqual([[red]]);
});
