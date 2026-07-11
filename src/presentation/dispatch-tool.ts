import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type {
	DispatchService,
	TaskAttemptSummary,
} from "../application/dispatch-service";
import { dispatchRequestSchema } from "../domain/dispatch";
import { renderDispatchResult } from "./dispatch-card";

export interface LegionDispatchDetails {
	readonly jobId: string;
	readonly recordId: string;
	readonly state: "running";
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
	readonly taskBreakdown: readonly TaskAttemptSummary[];
}

export type DispatchServiceResolver = () => DispatchService | undefined;

function immediateResult(
	details: LegionDispatchDetails,
): AgentToolResult<LegionDispatchDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Legion dispatch scheduled as host job ${details.jobId}. Expert results will be delivered asynchronously.`,
			},
		],
		details,
	};
}

export function createDispatchTool(
	resolveService: DispatchServiceResolver,
): ToolDefinition<typeof dispatchRequestSchema, LegionDispatchDetails> {
	return {
		name: "legion_dispatch",
		label: "Legion",
		description:
			"Runs one task through several independent expert attempts in parallel and returns a single synthesized, cross-checked answer — an ensemble review, not a subagent spawner. Use it whenever a task is a judgment call where being wrong is costly and a second opinion would catch it, even if the user never asks for review or mentions this tool by name: security-sensitive changes, a subtle correctness bug, an architecture or design decision, or any moment where the right move is to sanity-check the answer before committing to it. Do not use it for routine, low-stakes work that can just be done directly — ensembling has real latency and token cost. The call returns immediately with a job id and delivers its result asynchronously, including an automatic escalation to a human if the experts disagree too much or confidence is low, so never block waiting on it. Omit tasks to let it decompose the task automatically, or supply an explicit tasks array when the natural split is already known. Never call this tool from inside a task that this tool itself dispatched — experts give one independent answer and must not spawn further ensembles.",
		parameters: dispatchRequestSchema,
		approval: "exec",
		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			if (signal?.aborted) {
				return {
					content: [
						{
							type: "text",
							text: "Legion dispatch was cancelled before scheduling.",
						},
					],
				};
			}

			const service = resolveService();
			if (!service) {
				return {
					content: [
						{
							type: "text",
							text: "Legion dispatch is not ready; the session has not finished starting.",
						},
					],
				};
			}

			try {
				const accepted = service.dispatch(params, toolCallId);
				const details: LegionDispatchDetails = {
					jobId: accepted.jobId,
					recordId: accepted.recordId,
					state: "running",
					attemptCount: accepted.attemptCount,
					attemptModels: accepted.attemptModels,
					taskBreakdown: accepted.taskBreakdown,
				};
				const result = immediateResult(details);
				onUpdate?.(result);
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{ type: "text", text: `Legion dispatch rejected: ${message}` },
					],
				};
			}
		},
		renderResult: (result, _options, theme, args) =>
			renderDispatchResult(result, theme, args),
	};
}
