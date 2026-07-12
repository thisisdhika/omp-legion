import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Text } from "@oh-my-pi/pi-tui";

import type {
	DispatchService,
	TaskAttemptSummary,
} from "../application/dispatch-service";
import {
	LEGION_DISPATCH_PHASES,
	type LegionDispatchPhase,
} from "../domain/constants";
import {
	dispatchRequestSchema,
	shortAgentName,
	shortModelName,
} from "../domain/dispatch";
import { boxBorder, renderDispatchResult } from "./dispatch-card";
import { buildProgressText, spinnerChar, useSpinnerLoop } from "./spinner";

/** Emitted while the background job is being monitored by the host TUI. */
export interface LegionProgress {
	readonly phase: string;
	readonly frame: number;
	readonly jobId: string;
	readonly attemptCount: number;
}

export interface LegionDispatchDetails {
	readonly jobId: string;
	readonly recordId: string;
	readonly state: "running" | "completed" | "failed";
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
	readonly taskBreakdown: readonly TaskAttemptSummary[];
	readonly resultText?: string;
}

export type DispatchServiceResolver = () => DispatchService | undefined;

/**
 * Without a `renderCall`, the host falls back to a plain `theme.bold(label)`
 * line above every render of this tool (see tool-execution.ts) — a redundant
 * "Legion" heading floating above our own framed card, which already has its
 * own header. Every native tool (task included) avoids this the same way: by
 * defining `renderCall` at all, even a no-op one, so the fallback never fires.
 */
const EMPTY_COMPONENT: Component = { render: () => [] };

function emptyDetails(): LegionDispatchDetails {
	return {
		jobId: "",
		recordId: "",
		state: "failed",
		attemptCount: 0,
		attemptModels: [],
		taskBreakdown: [],
	};
}

function progressPartial(
	progress: LegionProgress,
): AgentToolResult<LegionDispatchDetails> {
	return {
		content: [
			{
				type: "text",
				text: buildProgressText(
					progress.phase,
					progress.frame,
					progress.attemptCount,
				),
			},
		],
		details: {
			jobId: progress.jobId,
			recordId: progress.jobId,
			state: "running",
			attemptCount: progress.attemptCount,
			attemptModels: [],
			taskBreakdown: [],
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Labels the widget should never linger on: once reached, the job is done
 * and the widget should clear immediately. Checked directly against
 * `describePhase()`'s label so the widget's own spinner tick can close
 * itself the instant `lastProgressDetails` reports one of these — instead of
 * only reacting to a *separate* poll of `job.status`, which can lag behind
 * `lastProgressDetails` by however long it takes the scheduler to mark the
 * job terminal after its last progress report. That gap previously left a
 * widget showing "[COMPLETED] done" with a still-ticking elapsed clock
 * (confirmed live) until the separate status poll eventually caught up.
 */
const TERMINAL_PHASE_LABELS = new Set(["COMPLETED", "FAILED", "REJECTED"]);

const PHASE_LABELS: Record<LegionDispatchPhase, string> = {
	decomposing: "DECOMPOSING",
	running: "RUNNING",
	retrying: "RETRYING",
	expanding: "EXPANDING",
	synthesizing: "SYNTHESIZING",
	escalated: "ESCALATED",
	rejected: "REJECTED",
	completed: "COMPLETED",
	failed: "FAILED",
};

function isLegionDispatchPhase(value: unknown): value is LegionDispatchPhase {
	return (
		typeof value === "string" &&
		(LEGION_DISPATCH_PHASES as readonly string[]).includes(value)
	);
}

function phaseDetail(
	phase: LegionDispatchPhase,
	details: Record<string, unknown> | undefined,
): string {
	switch (phase) {
		case "decomposing":
			return "deciding how to split the task";
		case "running": {
			const completed = details?.completed;
			const total = details?.total;
			return typeof completed === "number" &&
				typeof total === "number" &&
				total > 0
				? `${completed}/${total} experts finished`
				: "experts working";
		}
		case "retrying": {
			const model = details?.model;
			return typeof model === "string"
				? `retrying on ${shortModelName(model)}`
				: "retrying a failed attempt";
		}
		case "expanding": {
			const model = details?.model;
			return typeof model === "string"
				? `one more attempt on ${shortModelName(model)}`
				: "resolving escalation";
		}
		case "synthesizing":
			return "merging outputs";
		case "escalated": {
			const reasons = details?.reasons;
			return Array.isArray(reasons) && reasons.length > 0
				? `waiting on a human — ${reasons.join(", ")}`
				: "waiting on a human decision";
		}
		case "rejected":
			return "human rejected — stopping";
		case "completed":
			return "done";
		case "failed":
			return "failed";
	}
}

/**
 * Reads the structured `phase` tag dispatch-service.ts attaches to every
 * reportProgress call (see LegionDispatchPhase), instead of guessing from
 * lastProgressText's prose via substring matching — accidentally correct as
 * long as no message's wording ever changed, and blind to real detail (live
 * attempt counts, which model a retry moved to) that the prose never
 * mentioned in a greppable way to begin with.
 *
 * No progress reported yet is a real, distinct state ("QUEUED" — the job is
 * scheduled but hasn't executed its first reportProgress call), not the same
 * as any phase that has actually begun; the old default silently claimed
 * "selecting experts" here even when nothing had started.
 */
export function describePhase(details: Record<string, unknown> | undefined): {
	label: string;
	detail: string;
} {
	const phase = isLegionDispatchPhase(details?.phase)
		? details.phase
		: undefined;
	if (!phase) return { label: "QUEUED", detail: "waiting to start" };
	return { label: PHASE_LABELS[phase], detail: phaseDetail(phase, details) };
}

function finalResult(
	details: LegionDispatchDetails,
	resultText?: string,
	isError?: boolean,
): AgentToolResult<LegionDispatchDetails> {
	return {
		content: resultText ? [{ type: "text", text: resultText }] : [],
		details,
		isError,
	};
}

function buildDetails(
	accepted: ReturnType<DispatchService["dispatch"]>,
	state: LegionDispatchDetails["state"],
	resultText?: string,
): LegionDispatchDetails {
	return {
		jobId: accepted.jobId,
		recordId: accepted.jobId,
		state,
		attemptCount: accepted.attemptCount,
		attemptModels: accepted.attemptModels,
		taskBreakdown: accepted.taskBreakdown,
		resultText,
	};
}

type ProgressUpdate = Parameters<
	ToolDefinition<typeof dispatchRequestSchema, LegionDispatchDetails>["execute"]
>[3];

function monitorInBackground(
	accepted: ReturnType<DispatchService["dispatch"]>,
	service: DispatchService,
	onUpdate: ProgressUpdate | undefined,
): void {
	if (!onUpdate) return;
	const spinner = useSpinnerLoop(80);
	let active = true;
	const emit = (frame: number) => {
		if (!active) return;
		const job = service.getJob(accepted.jobId);
		const { label, detail } = describePhase(job?.lastProgressDetails);
		onUpdate(
			progressPartial({
				phase: `${label} — ${detail}`,
				frame,
				jobId: accepted.jobId,
				attemptCount: accepted.attemptCount,
			}),
		);
	};
	spinner.start(emit);
	void (async () => {
		while (active) {
			const job = service.getJob(accepted.jobId);
			if (job?.status === "completed" || job?.status === "failed") {
				active = false;
				spinner.stop();
				return;
			}
			await sleep(200);
		}
	})();
}

export function createDispatchTool(
	resolveService: DispatchServiceResolver,
): ToolDefinition<typeof dispatchRequestSchema, LegionDispatchDetails> {
	function monitorWidget(
		accepted: ReturnType<DispatchService["dispatch"]>,
		service: DispatchService,
		context: ExtensionContext,
	): void {
		if (!context?.ui?.setWidget) return;
		const key = `legion:${accepted.jobId}`;
		const startedAt = Date.now();
		// The job's own human-readable slug, stripped of the "legion-" prefix
		// already implied by the "Legion" widget heading — without this, two
		// or more concurrent widgets (a genuinely multi-part dispatch fanning
		// out into several legion_dispatch calls) render identically, and a
		// user watching live has no way to tell which is which (confirmed
		// live: two widgets both showing bare "Legion | 0:54").
		const jobLabel = shortAgentName(accepted.jobId);
		const render = (frame: number, label: string, detail: string) => {
			context.ui.setWidget(
				key,
				(_tui, theme) => {
					// Task/plan/models already sit in the persisted tool-call card
					// below; this ephemeral widget only shows what's actually live —
					// which phase, how long, and (if reported) what's happening in it.
					const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
					const elapsed = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
					const header = `${spinnerChar(frame)} Legion (${jobLabel}) | ${elapsed}`;
					const status = `[${label}] ${detail}`;
					const box = new Box(1, 0, undefined, boxBorder(theme, "accent"));
					box.addChild(
						new Text(
							theme.fg?.("accent", theme.bold?.(header) ?? header) ?? header,
							0,
							0,
						),
					);
					box.addChild(new Text(theme.fg?.("muted", status) ?? status, 0, 0));
					return box;
				},
				{ placement: "aboveEditor" },
			);
		};
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			spinner.stop();
			context.ui.setWidget(key, undefined);
		};
		const spinner = useSpinnerLoop(80);
		spinner.start((frame) => {
			if (closed) return;
			const { label, detail } = describePhase(
				service.getJob(accepted.jobId)?.lastProgressDetails,
			);
			if (TERMINAL_PHASE_LABELS.has(label)) {
				close();
				return;
			}
			render(frame, label, detail);
		});
		void (async () => {
			while (!closed) {
				const job = service.getJob(accepted.jobId);
				if (job?.status === "completed" || job?.status === "failed") {
					close();
					return;
				}
				await sleep(200);
			}
		})();
	}
	return {
		name: "legion_dispatch",
		label: "Legion",
		description:
			'Runs one task through several independent expert attempts in parallel and returns a single synthesized, cross-checked answer — an ensemble review, not a subagent spawner. Use it whenever a task is a judgment call where being wrong is costly and a second opinion would catch it, even if the user never asks for review or mentions this tool by name: security-sensitive changes, a subtle correctness bug, an architecture or design decision, or any moment where the right move is to sanity-check the answer before committing to it. Do not use it for routine, low-stakes work that can just be done directly — ensembling has real latency and token cost. Returns immediately with the job ID; the ensemble and any HOTL governance continue asynchronously in the background. Never call this tool from inside a task that this tool itself dispatched — experts give one independent answer and must not spawn further ensembles. Omit tasks to let it decompose the task automatically, or supply an explicit tasks array when the natural split is already known. When supplying explicit tasks, each task\'s `role` must be a bare role name matching an available `legion-<role>` persona (e.g. "reviewer", "coder") — not capitalized ("Reviewer"), not prefixed ("legion-reviewer", which resolves to the non-existent "legion-legion-reviewer" and is rejected). An unmatched role rejects the whole dispatch with the exact persona list rather than substituting a different one.',
		parameters: dispatchRequestSchema,
		approval: "exec",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return finalResult(emptyDetails(), undefined, true);
			}

			const service = resolveService();
			if (!service) {
				return finalResult(
					emptyDetails(),
					"Legion dispatch is not ready; the session has not finished starting.",
					true,
				);
			}

			let accepted: ReturnType<DispatchService["dispatch"]>;
			try {
				accepted = service.dispatch(params, _toolCallId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return finalResult(
					emptyDetails(),
					`Legion dispatch rejected: ${message}`,
					true,
				);
			}

			monitorWidget(accepted, service, ctx);
			monitorInBackground(accepted, service, onUpdate);
			return finalResult(
				buildDetails(accepted, "running"),
				`Legion job ${accepted.jobId} accepted and running in the background.`,
			);
		},
		renderCall: () => EMPTY_COMPONENT,
		renderResult: (result, options, theme, args) =>
			renderDispatchResult(result, options, theme, args),
	};
}
