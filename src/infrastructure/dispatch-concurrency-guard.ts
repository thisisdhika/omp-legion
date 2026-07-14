import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";

import {
	type DispatchContext,
	currentDispatchContext,
} from "./agent-execution-context";

export const MAX_CONCURRENT_LEGION_DISPATCHES = 2;
export const DEFAULT_STALE_ADMISSION_TIMEOUT_MS = 10 * 60_000;

const TASK_TOOL_NAME = "task";
const LEGION_DISPATCH_TOOL_NAME = "legion_dispatch";

type AdmissionEntry = {
	readonly kind: DispatchKind;
	readonly primary: boolean;
	readonly generation: number;
};

interface AdmissionTimer {
	readonly handle: ReturnType<typeof setTimeout>;
	readonly generation: number;
}

export type DispatchKind = "task" | "legion_dispatch";

export interface DispatchAdmissionState {
	readonly pending: Map<string, AdmissionEntry>;
	readonly timers: Map<string, AdmissionTimer>;
	readonly staleAdmissionTimeoutMs: number;
	generation: number;
}

export interface DispatchAdmissionDecision {
	readonly block: boolean;
	reason?: string;
}

export interface DispatchConcurrencyGuardOptions {
	readonly staleAdmissionTimeoutMs?: number;
}

export function createDispatchAdmissionState(
	staleAdmissionTimeoutMs = DEFAULT_STALE_ADMISSION_TIMEOUT_MS,
): DispatchAdmissionState {
	if (!Number.isFinite(staleAdmissionTimeoutMs) || staleAdmissionTimeoutMs < 0)
		throw new Error(
			"staleAdmissionTimeoutMs must be a finite non-negative number.",
		);
	return {
		pending: new Map(),
		timers: new Map(),
		staleAdmissionTimeoutMs,
		generation: 0,
	};
}

/**
 * Missing context is the trusted primary/host control plane. Expert calls are
 * bypassed only because HostExpertExecutor wraps every run in
 * runAsDispatchedAgent(), which propagates senderKind="expert" through the
 * shared AsyncLocalStorage used by currentDispatchContext(). If a future
 * executor emits tool events outside that wrapper, it is an integration bug and
 * will fail closed as a primary call rather than guessing from tool arguments.
 */
function isPrimary(context: DispatchContext | undefined): boolean {
	return context?.senderKind !== "expert";
}

export function evictStaleAdmission(
	state: DispatchAdmissionState,
	toolCallId: string,
	generation: number,
): void {
	const entry = state.pending.get(toolCallId);
	if (entry?.generation === generation) state.pending.delete(toolCallId);
	const timer = state.timers.get(toolCallId);
	if (timer?.generation === generation) state.timers.delete(toolCallId);
}

function scheduleEviction(
	state: DispatchAdmissionState,
	toolCallId: string,
	generation: number,
): void {
	const handle = setTimeout(
		() => evictStaleAdmission(state, toolCallId, generation),
		state.staleAdmissionTimeoutMs,
	);
	const timerWithUnref = handle as { unref?: () => void };
	timerWithUnref.unref?.();
	state.timers.set(toolCallId, { handle, generation });
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

	const pendingKinds = new Set(
		[...state.pending.values()].map((entry) => entry.kind),
	);
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
		[...state.pending.values()].filter(
			(entry) => entry.kind === "legion_dispatch",
		).length >= MAX_CONCURRENT_LEGION_DISPATCHES
	)
		return {
			block: true,
			reason: `At most ${MAX_CONCURRENT_LEGION_DISPATCHES} legion_dispatch calls may run concurrently.`,
		};

	const generation = ++state.generation;
	state.pending.set(toolCallId, {
		kind: toolName === TASK_TOOL_NAME ? "task" : "legion_dispatch",
		primary: true,
		generation,
	});
	scheduleEviction(state, toolCallId, generation);
	return { block: false };
}

export function releaseDispatch(
	state: DispatchAdmissionState,
	toolCallId: string,
): void {
	const entry = state.pending.get(toolCallId);
	if (!entry) return;
	const timer = state.timers.get(toolCallId);
	if (timer?.generation === entry.generation) {
		clearTimeout(timer.handle);

		state.timers.delete(toolCallId);
	}
	state.pending.delete(toolCallId);
}
function trackNativeTaskLifecycle(
	state: DispatchAdmissionState,
	payload: SubagentLifecyclePayload,
): void {
	const toolCallId = payload.parentToolCallId;
	if (!payload.detached || !toolCallId) return;
	if (payload.status === "started") {
		if (state.pending.has(toolCallId)) return;
		const generation = ++state.generation;
		state.pending.set(toolCallId, { kind: "task", primary: true, generation });
		scheduleEviction(state, toolCallId, generation);
		return;
	}
	releaseDispatch(state, toolCallId);
}

function clearAdmissions(state: DispatchAdmissionState): void {
	for (const timer of state.timers.values()) clearTimeout(timer.handle);
	state.timers.clear();
	state.pending.clear();
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

export const DEPENDENCY_NOTICE =
	"This subagent is still running in the background. If your next work depends on its result, poll its job and incorporate that result before proceeding on that dependent line; unrelated work may continue.";

export function registerDispatchConcurrencyGuard(
	api: ExtensionAPI,
	options: DispatchConcurrencyGuardOptions = {},
): void {
	const state = createDispatchAdmissionState(
		options.staleAdmissionTimeoutMs ?? DEFAULT_STALE_ADMISSION_TIMEOUT_MS,
	);
	api.events?.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload) => {
		trackNativeTaskLifecycle(state, payload as SubagentLifecyclePayload);
	});
	api.on("session_start", () => clearAdmissions(state));
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
		const entry = state.pending.get(event.toolCallId);
		releaseDispatch(state, event.toolCallId);
		if (
			entry?.primary &&
			entry.kind === "task" &&
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
