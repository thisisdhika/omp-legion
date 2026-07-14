import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
	runWithDispatchContext,
} from "../../src/infrastructure/agent-execution-context";
import {
	DEFAULT_STALE_ADMISSION_TIMEOUT_MS,
	DEPENDENCY_NOTICE,
	type DispatchAdmissionState,
	MAX_CONCURRENT_LEGION_DISPATCHES,
	createDispatchAdmissionState,
	evaluateDispatchAdmission,
	evictStaleAdmission,
	registerDispatchConcurrencyGuard,
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
type GuardHandlers = {
	toolCall?: (event: ToolCallEvent) => unknown;
	toolResult?: (event: ToolResultEvent) => unknown;
	sessionStart?: () => unknown;
};

function registerHandlers(
	staleAdmissionTimeoutMs = 10 * 60_000,
): GuardHandlers {
	const handlers: GuardHandlers = {};
	const api = {
		on(event: string, handler: (event?: unknown) => unknown) {
			if (event === "tool_call")
				handlers.toolCall = handler as GuardHandlers["toolCall"];
			if (event === "tool_result")
				handlers.toolResult = handler as GuardHandlers["toolResult"];
			if (event === "session_start")
				handlers.sessionStart = handler as GuardHandlers["sessionStart"];
		},
	} as unknown as ExtensionAPI;
	registerDispatchConcurrencyGuard(api, { staleAdmissionTimeoutMs });
	return handlers;
}

describe("dispatch concurrency guard", () => {
	test("allows multiple native task calls", () => {
		const state = createDispatchAdmissionState();
		expect(admit(state, "task", "task-1").block).toBe(false);
		expect(admit(state, "task", "task-2").block).toBe(false);
	});
	test("uses a ten-minute stale admission timeout by default", () => {
		expect(createDispatchAdmissionState().staleAdmissionTimeoutMs).toBe(
			DEFAULT_STALE_ADMISSION_TIMEOUT_MS,
		);
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

	test("evicts a stale admission and permits recovery", () => {
		const state = createDispatchAdmissionState();
		expect(admit(state, "task", "stuck-task").block).toBe(false);
		const entry = state.pending.get("stuck-task");
		expect(entry).toBeDefined();
		evictStaleAdmission(state, "stuck-task", entry?.generation ?? -1);
		expect(state.pending.has("stuck-task")).toBe(false);
		expect(state.timers.has("stuck-task")).toBe(false);
		expect(admit(state, "legion_dispatch", "recovered-legion").block).toBe(
			false,
		);
	});

	test("tool_result releases the admission and clears its timer", () => {
		const handlers = registerHandlers();
		handlers.toolCall?.({
			type: "tool_call",
			toolCallId: "task-1",
			toolName: "task",
			input: {},
		});
		const result = handlers.toolResult?.({
			type: "tool_result",
			toolCallId: "task-1",
			toolName: "task",
			input: {},
			content: [{ type: "text", text: "done" }],
			details: {},
			isError: false,
		});
		expect(result).toBeUndefined();
		const next = handlers.toolCall?.({
			type: "tool_call",
			toolCallId: "legion-1",
			toolName: "legion_dispatch",
			input: {},
		}) as { block?: boolean } | undefined;
		expect(next?.block ?? false).toBe(false);
	});

	test("injects the dependency reminder for a running primary task", () => {
		const handlers = registerHandlers();
		handlers.toolCall?.({
			type: "tool_call",
			toolCallId: "async-task",
			toolName: "task",
			input: {},
		});
		const result = handlers.toolResult?.({
			type: "tool_result",
			toolCallId: "async-task",
			toolName: "task",
			input: {},
			content: [{ type: "text", text: "Spawned background task." }],
			details: { async: { state: "running", jobId: "job-1" } },
			isError: false,
		});
		const text = (result as { content: [{ text: string }] }).content[0].text;
		expect(text).toContain("Spawned background task.");
		expect(text).toContain(DEPENDENCY_NOTICE);
		expect(text.match(new RegExp(DEPENDENCY_NOTICE, "g"))).toHaveLength(1);
	});

	test("uses the real AsyncLocalStorage context for expert bypass", async () => {
		const handlers = registerHandlers();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-reviewer",
			parentRoute: LEGION_DISPATCH_PARENT_ROUTE,
			allowedDestination: LEGION_DISPATCH_PARENT_ROUTE,
		};
		await runWithDispatchContext(expertContext, async () => {
			const decision = handlers.toolCall?.({
				type: "tool_call",
				toolCallId: "expert-task",
				toolName: "task",
				input: {},
			}) as { block?: boolean } | undefined;
			expect(decision).toBeUndefined();
		});
		const primaryDecision = handlers.toolCall?.({
			type: "tool_call",
			toolCallId: "primary-task",
			toolName: "task",
			input: {},
		}) as { block?: boolean } | undefined;
		expect(primaryDecision?.block ?? false).toBe(false);
	});
});
