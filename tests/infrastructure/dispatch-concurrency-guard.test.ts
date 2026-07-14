import { describe, expect, test } from "bun:test";

import {
	type DispatchAdmissionState,
	MAX_CONCURRENT_LEGION_DISPATCHES,
	createDispatchAdmissionState,
	evaluateDispatchAdmission,
	releaseDispatch,
} from "../../src/infrastructure/dispatch-concurrency-guard";

const primary = undefined;
const expert = {
	senderKind: "expert",
	parentRoute: "legion-dispatch",
	allowedDestination: "legion-dispatch",
} as const;

function admit(state: DispatchAdmissionState, tool: string, id: string) {
	return evaluateDispatchAdmission(state, primary, tool, id);
}

describe("dispatch concurrency guard", () => {
	test("allows multiple native task calls", () => {
		const state = createDispatchAdmissionState();
		expect(admit(state, "task", "task-1").block).toBe(false);
		expect(admit(state, "task", "task-2").block).toBe(false);
	});

	test("mutually excludes task and legion dispatch calls", () => {
		const state = createDispatchAdmissionState();
		expect(admit(state, "task", "task-1").block).toBe(false);
		expect(admit(state, "legion_dispatch", "legion-1").block).toBe(true);
		releaseDispatch(state, "task-1");
		expect(admit(state, "legion_dispatch", "legion-1").block).toBe(false);
		expect(admit(state, "task", "task-2").block).toBe(true);
	});

	test(`caps concurrent Legion calls at ${MAX_CONCURRENT_LEGION_DISPATCHES}`, () => {
		const state = createDispatchAdmissionState();
		for (let index = 0; index < MAX_CONCURRENT_LEGION_DISPATCHES; index++)
			expect(admit(state, "legion_dispatch", `legion-${index}`).block).toBe(
				false,
			);
		expect(admit(state, "legion_dispatch", "legion-third").block).toBe(true);
	});

	test("does not constrain expert tool calls", () => {
		const state = createDispatchAdmissionState();
		expect(
			evaluateDispatchAdmission(state, expert, "legion_dispatch", "expert-1")
				.block,
		).toBe(false);
		expect(
			evaluateDispatchAdmission(state, expert, "task", "expert-2").block,
		).toBe(false);
		expect(state.pending.size).toBe(0);
	});

	test("allows unrelated primary tools", () => {
		const state = createDispatchAdmissionState();
		admit(state, "legion_dispatch", "legion-1");
		expect(admit(state, "edit", "edit-1").block).toBe(false);
	});
});
