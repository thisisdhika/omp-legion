import { describe, expect, test } from "bun:test";

import type { DispatchRecord } from "../../src/domain/dispatch";
import { HostOrchestrationRepository } from "../../src/infrastructure/host-orchestration-repository";

class SessionJournal {
	readonly entries: unknown[] = [];

	getEntries(): readonly unknown[] {
		return this.entries;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		this.entries.push({ type: "custom", customType, data });
		return String(this.entries.length);
	}
}

function runningRecord(): DispatchRecord {
	return {
		id: "job-1",
		task: "Add a null guard",
		state: "running",
		createdAt: 100,
		attempts: [
			{
				id: "attempt-1",
				taskId: "task-1",
				agent: "task",
				role: "reviewer",
				assignment: "Inspect the access",
				model: "provider/model",
				index: 0,
			},
		],
	};
}

describe("HostOrchestrationRepository", () => {
	test("restores completed audit records and human resolutions", () => {
		const journal = new SessionJournal();
		const first = new HostOrchestrationRepository(journal);
		first.create(runningRecord());
		first.complete(
			"job-1",
			[],
			[],
			[],
			200,
			[
				{
					taskId: "task-1",
					action: "edit",
					note: "Keep the guard before access.",
				},
			],
			[
				{
					selector: "provider/model",
					index: 0,
					status: "success",
					timestamp: 150,
				},
			],
		);

		const afterRestart = new HostOrchestrationRepository(journal);
		const restored = afterRestart.get("job-1");

		expect(restored?.state).toBe("completed");
		expect(restored?.completedAt).toBe(200);
		expect(restored?.resolutions).toEqual([
			{
				taskId: "task-1",
				action: "edit",
				note: "Keep the guard before access.",
			},
		]);
		expect(restored?.decomposerAttempts).toEqual([
			{
				selector: "provider/model",
				index: 0,
				status: "success",
				timestamp: 150,
			},
		]);
	});
});
