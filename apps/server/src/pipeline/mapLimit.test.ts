import { describe, expect, it } from "vitest";
import { mapLimit } from "./mapLimit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("keeps order and respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(x);
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("waits for in-flight work and starts nothing new after a failure", async () => {
    const finished: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
        if (x === 0) throw new Error("boom");
        await sleep(10);
        finished.push(x);
      }),
    ).rejects.toThrow("boom");
    // Item 1 was already running and completed; nothing after the failure was scheduled
    // beyond what the second worker had in hand.
    expect(finished).toEqual([1]);
  });

  it("handles empty input", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
