import { z } from "zod";

import type { DecomposerPolicy, LegionConfig } from "./config";
import {
	DEFAULT_DECOMPOSITION_ROLE,
	DEFAULT_DECOMPOSITION_TASK_ID,
} from "./constants";
import type { DispatchTask } from "./dispatch";

/**
 * Only `role` (Legion's own semantic tag, used for modelMap lookup) is
 * LLM-chosen; the dispatch layer resolves the actual agent from that role.
 */
const decomposedTaskSchema = z.object({
	id: z.string().trim().min(1),
	role: z.string().trim().min(1),
	assignment: z.string().trim().min(1),
	description: z.string().trim().min(1).optional(),
});

const decompositionPayloadSchema = z.union([
	z.object({ tasks: z.array(decomposedTaskSchema).min(1) }),
	z.array(decomposedTaskSchema).min(1),
]);

export interface DecompositionInput {
	readonly task: string;
	readonly signal?: AbortSignal;
	readonly onAudit?: (event: DecomposerAuditEvent) => void;
	/** The dispatch job this decomposition belongs to, used to derive a stable subprocess id when the decomposer runs as a real (tool-using) subagent. Undefined in tests/callers that don't care about id stability. */
	readonly jobId?: string;
}

export interface TaskDecomposer {
	decompose(input: DecompositionInput): Promise<readonly DispatchTask[]>;
}

function jsonCandidates(output: string): string[] {
	const trimmed = output.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const objectStart = trimmed.indexOf("{");
	const objectEnd = trimmed.lastIndexOf("}");
	const object =
		objectStart >= 0 && objectEnd > objectStart
			? trimmed.slice(objectStart, objectEnd + 1)
			: undefined;
	return [
		...new Set(
			[trimmed, fenced, object].filter((value): value is string =>
				Boolean(value),
			),
		),
	];
}

function parsePayload(output: string): readonly DispatchTask[] {
	for (const candidate of jsonCandidates(output)) {
		try {
			const parsed = decompositionPayloadSchema.parse(JSON.parse(candidate));
			return Array.isArray(parsed) ? parsed : parsed.tasks;
		} catch {}
	}
	throw new Error("Decomposer returned invalid task JSON.");
}

export function parseDecompositionResponse(
	output: string,
): readonly DispatchTask[] {
	const tasks = parsePayload(output);
	const ids = new Set(tasks.map((task) => task.id));
	if (ids.size !== tasks.length)
		throw new Error("Decomposer returned duplicate task ids.");
	return tasks;
}

export function fallbackDecomposition(task: string): readonly DispatchTask[] {
	return [
		{
			id: DEFAULT_DECOMPOSITION_TASK_ID,
			role: DEFAULT_DECOMPOSITION_ROLE,
			assignment: task,
		},
	];
}

/**
 * Outcome recorded for each decomposer attempt so the dispatch audit can show
 * exactly which model was tried, in what order, and why it failed.
 * - `success`: model returned a valid decomposition.
 * - `retryable-failure`: the provider/completion call failed (network, quota,
 *   rate-limit, timeout, empty output, abort) — the decomposer advances to the
 *   next unattempted selector.
 * - `fatal-failure`: the provider/completion call failed with a non-retryable
 *   error (auth failure, context length exceeded) — the decomposer stops.
 * - `validation-failure`: the model answered but the response failed schema
 *   parsing/duplicate-id checks — a task-level error, NOT retried.
 * - `unavailable`: the selector could not be resolved to a model at runtime.
 * - `cancelled`: the attempt was skipped because the abort signal fired.
 */
export type DecomposerAttemptStatus =
	| "success"
	| "retryable-failure"
	| "fatal-failure"
	| "validation-failure"
	| "unavailable"
	| "cancelled";

export interface DecomposerAuditEvent {
	readonly selector: string;
	readonly index: number;
	readonly status: DecomposerAttemptStatus;
	/** Temperature sampled for this attempt from the policy's ladder (cycled by index). */
	readonly temperature?: number;
	readonly error?: string;
	readonly timestamp: number;
}

/**
 * Resolve the decomposer policy from resolved Legion config.
 *
 * Returns the explicit `legion.decomposer` policy when one is configured with
 * at least one model. When no policy is configured, returns `undefined` so the
 * caller falls back to the active session model (legacy behavior) rather than
 * running an empty ordered list.
 */
export function resolveDecomposerPolicy(
	config: LegionConfig,
): DecomposerPolicy | undefined {
	return config.decomposer && config.decomposer.models.length > 0
		? config.decomposer
		: undefined;
}
