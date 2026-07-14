import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	currentDispatchContext,
} from "./agent-execution-context";

export const MAX_CONCURRENT_LEGION_DISPATCHES = 2;

const TASK_TOOL_NAME = "task";
const LEGION_DISPATCH_TOOL_NAME = "legion_dispatch";

export type DispatchKind = "task" | "legion_dispatch";

export interface DispatchAdmissionState {
	readonly pending: Map<string, DispatchKind>;
}

export interface DispatchAdmissionDecision {
	readonly block: boolean;
	reason?: string;
}

export function createDispatchAdmissionState(): DispatchAdmissionState {
	return { pending: new Map() };
}

function isPrimary(context: DispatchContext | undefined): boolean {
	return context?.senderKind !== "expert";
}

export function evaluateDispatchAdmission(
	state: DispatchAdmissionState,
	context: DispatchContext | undefined,
	toolName: string,
	toolCallId: string,
): DispatchAdmissionDecision {
	if (!isPrimary(context)) return { block: false };
	if (toolName !== TASK_TOOL_NAME && toolName !== LEGION_DISPATCH_TOOL_NAME)
		return { block: false };
	if (state.pending.has(toolCallId)) return { block: false };

	const pendingKinds = new Set(state.pending.values());
	if (toolName === TASK_TOOL_NAME && pendingKinds.has("legion_dispatch"))
		return {
			block: true,
			reason:
				"Wait for the pending legion_dispatch result before starting a native task.",
		};
	if (toolName === LEGION_DISPATCH_TOOL_NAME && pendingKinds.has("task"))
		return {
			block: true,
			reason:
				"Wait for pending native task dispatches before starting legion_dispatch.",
		};
	if (
		toolName === LEGION_DISPATCH_TOOL_NAME &&
		[...state.pending.values()].filter((kind) => kind === "legion_dispatch")
			.length >= MAX_CONCURRENT_LEGION_DISPATCHES
	)
		return {
			block: true,
			reason: `At most ${MAX_CONCURRENT_LEGION_DISPATCHES} legion_dispatch calls may run concurrently.`,
		};

	state.pending.set(
		toolCallId,
		toolName === TASK_TOOL_NAME ? "task" : "legion_dispatch",
	);
	return { block: false };
}

export function releaseDispatch(
	state: DispatchAdmissionState,
	toolCallId: string,
): void {
	state.pending.delete(toolCallId);
}

function isRunningAsyncTask(details: unknown): boolean {
	if (details === null || typeof details !== "object" || !("async" in details))
		return false;
	const asyncDetails = details.async;
	return (
		asyncDetails !== null &&
		typeof asyncDetails === "object" &&
		"state" in asyncDetails &&
		"jobId" in asyncDetails &&
		asyncDetails.state === "running" &&
		typeof asyncDetails.jobId === "string"
	);
}

const DEPENDENCY_NOTICE =
	"This subagent is still running in the background. If your next work depends on its result, poll its job and incorporate that result before proceeding on that dependent line; unrelated work may continue.";

export function registerDispatchConcurrencyGuard(api: ExtensionAPI): void {
	const state = createDispatchAdmissionState();
	api.on("session_start", () => state.pending.clear());
	api.on("tool_call", (event) => {
		const decision = evaluateDispatchAdmission(
			state,
			currentDispatchContext(),
			event.toolName,
			event.toolCallId,
		);
		return decision.block ? decision : undefined;
	});
	api.on("tool_result", (event) => {
		releaseDispatch(state, event.toolCallId);
		if (
			event.toolName === TASK_TOOL_NAME &&
			isPrimary(currentDispatchContext()) &&
			isRunningAsyncTask(event.details)
		) {
			const content = event.content.map((part) =>
				part.type === "text"
					? { ...part, text: `${part.text}\n\n${DEPENDENCY_NOTICE}` }
					: part,
			);
			return { content };
		}
		return undefined;
	});
}
