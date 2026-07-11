import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "../../src/application/dispatch-service";
import { createDispatchTool } from "../../src/presentation/dispatch-tool";

describe("createDispatchTool", () => {
	test("dispatches through the session-scoped service resolver", async () => {
		const calls: string[] = [];
		const service = {
			dispatch(_params: unknown, toolCallId?: string) {
				calls.push(toolCallId ?? "missing");
				return {
					jobId: "job-1",
					recordId: "job-1",
					attemptCount: 3,
					attemptModels: ["provider/model"],
				};
			},
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		const result = await tool.execute(
			"call-1",
			{
				task: "Review the change",
				tasks: [
					{
						id: "review",
						agent: "reviewer",
						role: "reviewer",
						assignment: "Review it",
					},
				],
				modelMap: {},
				defaultEnsembleSize: 3,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(calls).toEqual(["call-1"]);
		expect(result.details?.jobId).toBe("job-1");
	});
});
