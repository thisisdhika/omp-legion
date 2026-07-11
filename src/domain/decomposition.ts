import { z } from "zod";

import {
	DEFAULT_DECOMPOSITION_AGENT,
	DEFAULT_DECOMPOSITION_ROLE,
	DEFAULT_DECOMPOSITION_TASK_ID,
} from "./constants";
import type { DispatchTask } from "./dispatch";

/**
 * The decomposer LLM has no visibility into which host agent types are
 * actually discoverable in this project — asking it to invent an `agent`
 * value produced unresolvable names in practice (host dispatch failed with
 * zero expert output). Only `role` (Legion's own semantic tag, used for
 * modelMap lookup) is LLM-chosen; `agent` is always normalized to
 * DEFAULT_DECOMPOSITION_AGENT below, never trusted from the LLM's output.
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
			const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
			return tasks.map((task) => ({
				...task,
				agent: DEFAULT_DECOMPOSITION_AGENT,
			}));
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
			agent: DEFAULT_DECOMPOSITION_AGENT,
			role: DEFAULT_DECOMPOSITION_ROLE,
			assignment: task,
		},
	];
}
