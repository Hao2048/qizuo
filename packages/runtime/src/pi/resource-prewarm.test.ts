import { afterEach, expect, it, vi } from "vitest";
import { schedulePreparation, sharedPreparation } from "./resource-prewarm.js";

afterEach(() => vi.useRealTimers());

it("foreground joins pending background preparation and reuses the successful result", async () => {
	let finish!: (value: object) => void;
	const prepare = vi.fn(() => new Promise<object>(resolve => { finish = resolve; }));
	const load = sharedPreparation(prepare);
	const background = load();
	await Promise.resolve();
	const foreground = load();
	expect(foreground).toBe(background);
	const value = {}; finish(value);
	expect(await foreground).toBe(value);
	expect(await load()).toBe(value);
	expect(prepare).toHaveBeenCalledTimes(1);
});

it("failed background preparation can retry, including synchronous failure", async () => {
	const prepare = vi.fn().mockImplementationOnce(() => { throw new Error("temporary"); }).mockResolvedValue("ready");
	const load = sharedPreparation(prepare);
	await expect(load()).rejects.toThrow("temporary");
	expect(await load()).toBe("ready");
	expect(prepare).toHaveBeenCalledTimes(2);
});

it("startup preparation is deferred and cancelled on disposal", async () => {
	vi.useFakeTimers();
	const prepare = vi.fn().mockResolvedValue(undefined);
	const cancel = schedulePreparation(prepare, vi.fn());
	await vi.advanceTimersByTimeAsync(1000);
	expect(prepare).not.toHaveBeenCalled();
	cancel();
	await vi.runAllTimersAsync();
	expect(prepare).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it("optional preparation failure is reported without blocking startup or firing after disposal", async () => {
	vi.useFakeTimers();
	let reject!: (error: Error) => void;
	const prepare = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
	const onError = vi.fn();
	const cancel = schedulePreparation(prepare, onError);
	await vi.advanceTimersByTimeAsync(1500);
	expect(prepare).toHaveBeenCalledTimes(1);
	cancel(); reject(new Error("late failure"));
	await vi.runAllTimersAsync();
	expect(onError).not.toHaveBeenCalled();
	schedulePreparation(async () => { throw new Error("retry later"); }, onError);
	await vi.runAllTimersAsync();
	expect(onError).toHaveBeenCalledTimes(1);
});
