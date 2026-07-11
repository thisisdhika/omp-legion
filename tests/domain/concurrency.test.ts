import { describe, expect, test } from "bun:test";

import { Semaphore } from "../../src/domain/concurrency";

describe("Semaphore", () => {
	test("allows up to capacity concurrent holders", async () => {
		const semaphore = new Semaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();

		let thirdAcquired = false;
		const third = semaphore.acquire().then(() => {
			thirdAcquired = true;
		});

		await Promise.resolve();
		expect(thirdAcquired).toBe(false);

		semaphore.release();
		await third;
		expect(thirdAcquired).toBe(true);
	});

	test("queued acquires resolve in FIFO order as slots free up", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();

		const order: number[] = [];
		const second = semaphore.acquire().then(() => order.push(2));
		const third = semaphore.acquire().then(() => order.push(3));

		semaphore.release();
		await second;
		semaphore.release();
		await third;

		expect(order).toEqual([2, 3]);
	});

	test("rejects a non-positive capacity", () => {
		expect(() => new Semaphore(0)).toThrow();
	});
});
