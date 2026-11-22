import { describe, expect, it, vi } from "vitest";
import { createCellAutosave } from "../src/client/cell-autosave";
import { parseMoney } from "../src/shared/money";

const events = () => ({ saved: vi.fn(), failed: vi.fn(), settled: vi.fn() });
describe("spreadsheet cell autosave", () => {
  it("coalesces simultaneous blur, Tab, and click into one write", async () => {
    const autosave = createCellAutosave();
    let finish!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const callbacks = events();
    const first = autosave.save(write, callbacks);
    const second = autosave.save(write, callbacks);
    const third = autosave.save(write, callbacks);
    expect(second).toBe(first);
    expect(third).toBe(first);
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
    expect(callbacks.saved).toHaveBeenCalledTimes(1);
    expect(callbacks.failed).not.toHaveBeenCalled();
    expect(callbacks.settled).toHaveBeenCalledTimes(1);
    expect(autosave.pending).toBeNull();
  });

  it("keeps a synchronously invalid amount recoverable and accepts a corrected draft", async () => {
    const autosave = createCellAutosave();
    const callbacks = events();
    const persist = vi.fn(async (_amount: number) => {});
    expect(
      await autosave.save(() => persist(parseMoney("invalid")), callbacks),
    ).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter an amount with at most two decimal places",
      }),
    );
    expect(callbacks.saved).not.toHaveBeenCalled();
    expect(autosave.pending).toBeNull();
    expect(
      await autosave.save(() => persist(parseMoney("-135.25")), callbacks),
    ).toBe(true);
    expect(persist).toHaveBeenCalledWith(-13525);
    expect(callbacks.saved).toHaveBeenCalledTimes(1);
    expect(callbacks.settled).toHaveBeenCalledTimes(2);
  });

  it("does not mark rejected requests saved and permits retry with the same value", async () => {
    const autosave = createCellAutosave();
    const callbacks = events();
    const failure = Error("Connection interrupted");
    const write = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    expect(await autosave.save(write, callbacks)).toBe(false);
    expect(callbacks.failed).toHaveBeenCalledWith(failure);
    expect(callbacks.saved).not.toHaveBeenCalled();
    expect(autosave.pending).toBeNull();
    expect(await autosave.save(write, callbacks)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(callbacks.saved).toHaveBeenCalledTimes(1);
  });
});
