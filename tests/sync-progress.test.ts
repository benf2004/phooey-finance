import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { syncJobProgress } from "../src/server/sync";
import { BankSyncQueue, type SyncJob } from "../src/client/pages/BankSyncQueue";

const start = Date.parse("2026-01-01") / 1000;
const day = 86400;
const payload = {
  generation: "test",
  initialCursor: start,
  cursor: start,
  end: start + 100 * day,
};

describe("bank sync progress", () => {
  it("counts committed chunks and date ranges across a multi-window import", () => {
    expect(syncJobProgress(payload, "queued")).toMatchObject({
      percent: 0,
      totalWindows: 3,
      recordsProcessed: 0,
    });
    const partial = {
      ...payload,
      cursor: start + 45 * day,
      processedRecords: 205,
      windowRecords: 200,
      offset: 100,
    };
    expect(syncJobProgress(partial, "queued")).toMatchObject({
      percent: 50,
      completedWindows: 1,
      recordsProcessed: 305,
    });
    expect(syncJobProgress(partial, "failed")).toEqual(
      syncJobProgress(partial, "running"),
    );
    expect(
      syncJobProgress(
        { ...payload, cursor: payload.end, processedRecords: 505 },
        "complete",
      ),
    ).toMatchObject({
      percent: 100,
      totalWindows: 3,
      completedWindows: 3,
      recordsProcessed: 505,
    });
  });
  it("handles empty windows and never shows unfinished work as complete", () => {
    expect(
      syncJobProgress({ ...payload, windowRecords: 0, offset: 0 }, "running")
        .percent,
    ).toBe(0);
    expect(
      syncJobProgress(
        { ...payload, end: start + day, windowRecords: 100, offset: 100 },
        "running",
      ).percent,
    ).toBe(99);
    expect(
      syncJobProgress(
        { ...payload, end: start + day, cursor: start + day },
        "complete",
      ).percent,
    ).toBe(100);
  });
  it("renders live progress, warnings, retry controls, and the empty state", () => {
    const render = (jobs: SyncJob[]) =>
      renderToStaticMarkup(
        createElement(BankSyncQueue, {
          jobs,
          loading: false,
          busy: false,
          onRetry: () => {},
        }),
      );
    expect(render([])).toContain("No bank syncs yet");
    const job: SyncJob = {
      id: "one",
      kind: "sync",
      status: "queued",
      created_at: "2026-11-22 12:00:00",
      progress: "Importing",
      error: null,
      syncProgress: syncJobProgress(payload, "queued"),
    };
    const active = render([job]);
    expect(active).toContain('aria-live="polite"');
    expect(active).toContain('aria-label="Bank sync progress"');
    expect(active).toContain('value="0"');
    expect(active).toContain("You can leave this page");
    expect(
      render([{ ...job, status: "failed", error: "Provider unavailable" }]),
    ).toContain("Retry sync");
    expect(
      render([{ ...job, status: "complete", error: "Missing history" }]),
    ).toContain("Complete with warnings");
  });
});
