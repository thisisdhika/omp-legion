import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "../application/dispatch-service";
import { dispatchRequestSchema } from "../domain/dispatch";
import { renderDispatchCall, renderDispatchResult } from "./dispatch-card";

export interface LegionDispatchDetails {
	readonly jobId: string;
	readonly recordId: string;
	readonly state: "running";
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
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
		label: "Legion Dispatch",
		description:
			"Dispatch one task through the host task executor. Omit tasks to let Legion decompose the task automatically; returns immediately with a host job id.",
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
		renderCall: (args, _options, theme) => renderDispatchCall(args, theme),
		renderResult: (result, _options, theme) =>
			renderDispatchResult(result, theme),
	};
}
