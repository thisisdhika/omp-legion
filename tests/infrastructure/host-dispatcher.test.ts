import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";

import { HostJobScheduler } from "../../src/infrastructure/host-dispatcher";

describe("HostJobScheduler", () => {
	test("delivers the parent result through the host completion callback", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		const scheduler = new HostJobScheduler(manager);

		const jobId = scheduler.schedule("legion-dispatch", async (context) => {
			await context.reportProgress("started");
			return "dispatch-result";
		});
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(deliveries).toEqual([{ jobId, text: "dispatch-result" }]);
		await manager.dispose();
	});
});
