import { expect, it } from "vitest";
import { RunConcurrency } from "./run-concurrency.js";
it("queues excess work and never exceeds the concurrency limit", async () => {
  const limits = new RunConcurrency({ maxConcurrent: 2 });
  let active = 0,
    peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 7 }, async (_, i) => {
      const release = await limits.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
      active--;
      release();
      release();
    }),
  );
  expect(peak).toBe(2);
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
});
it("stops queued work instead of launching it after cancellation", async () => {
  const limits = new RunConcurrency({ maxConcurrent: 1 });
  const release = await limits.acquire();
  const waiting = limits.acquire();
  limits.stop();
  await expect(limits.acquire()).rejects.toThrow("已停止");
  await expect(waiting).rejects.toThrow("已停止");
  release();
  await expect(limits.acquire()).rejects.toThrow("已停止");
});
it("does not cap sequential calls", async () => {
  const concurrency = new RunConcurrency({ maxConcurrent: 1 });
  for (let i = 0; i < 300; i++) (await concurrency.acquire())();
  expect(concurrency.check()).toBeNull();
});
