import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container, Text } from "@oh-my-pi/pi-tui";

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
	readonly attemptModels: readonly string[];
}

export interface LegionDispatchDetails {
	readonly jobId: string;
	readonly recordId: string;
	readonly state: "running" | "completed" | "failed";
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
	readonly taskBreakdown: readonly TaskAttemptSummary[];
	/** Number of expert attempts that produced a successful result. */
	readonly successfulAttemptCount?: number;
	/** Whether all synthesis stages produced usable synthesized content. */
	readonly synthesisSucceeded?: boolean;
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
				text: buildProgressText(progress.phase, progress.frame),
			},
		],
		details: {
			jobId: progress.jobId,
			recordId: progress.jobId,
			state: "running",
			attemptCount: progress.attemptCount,
			attemptModels: progress.attemptModels,
			taskBreakdown: [],
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDispatch(
	job: { promise: Promise<unknown> },
	service: DispatchService,
	jobId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const timeoutMs = service.getDispatchTimeoutMs?.() ?? 60 * 60_000;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			service.cancel(jobId);
			reject(new Error(`Legion dispatch timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
	});
	const aborted = signal
		? new Promise<never>((_, reject) => {
				abortListener = () => {
					service.cancel(jobId);
					reject(new Error("Legion dispatch aborted."));
				};
				signal.addEventListener("abort", abortListener, { once: true });
			})
		: undefined;
	try {
		const waits: Promise<unknown>[] = [job.promise, timedOut];
		if (aborted) waits.push(aborted);
		await Promise.race(waits);
	} finally {
		clearTimeout(timeoutHandle);
		if (abortListener) signal?.removeEventListener("abort", abortListener);
	}
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
	successfulAttemptCount?: number,
	synthesisSucceeded?: boolean,
): LegionDispatchDetails {
	return {
		jobId: accepted.jobId,
		recordId: accepted.jobId,
		state,
		attemptCount: accepted.attemptCount,
		attemptModels: accepted.attemptModels,
		taskBreakdown: accepted.taskBreakdown,
		successfulAttemptCount,
		synthesisSucceeded,
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
				attemptModels: accepted.attemptModels,
			}),
		);
	};
	spinner.start(emit);
	void (async () => {
		while (active) {
			const job = service.getJob(accepted.jobId);
			const details = describePhase(job?.lastProgressDetails);
			if (
				job?.status === "completed" ||
				job?.status === "failed" ||
				job?.status === "cancelled" ||
				TERMINAL_PHASE_LABELS.has(details.label)
			) {
				onUpdate(
					progressPartial({
						phase: `${details.label} — ${details.detail}`,
						frame: 0,
						jobId: accepted.jobId,
						attemptCount: accepted.attemptCount,
						attemptModels: accepted.attemptModels,
					}),
				);
				active = false;
				spinner.stop();
				return;
			}
			await sleep(200);
		}
	})().catch((error) => {
		console.warn("Legion progress monitor stopped unexpectedly.", error);
		active = false;
		spinner.stop();
	});
}

/** One row's live state within the shared, multi-job widget. */
interface JobWidgetEntry {
	readonly jobLabel: string;
	readonly startedAt: number;
	label: string;
	detail: string;
}

/**
 * All concurrent dispatches render into this single widget key rather than
 * one key per job. The host's own `setHookWidget` unconditionally deletes
 * and re-inserts a key's entry into its internal `Map` on every call — even
 * an in-place update — which pushes that key to the end of the Map's
 * iteration order every time (confirmed in
 * `extension-ui-controller.ts#setHookWidget`). With one widget key per job,
 * two concurrent dispatches ticking their own spinners independently would
 * keep leapfrogging each other in display order on every render tick.
 * Consolidating into one shared key sidesteps that entirely: the host only
 * ever churns one key's position, and the row order *within* that widget is
 * ours to control — `activeJobs` is only ever `.set()` for a brand-new job
 * id (append) or `.delete()`d on completion, never delete-then-re-add for an
 * in-place update, so `Map` iteration order stays exactly first-appeared
 * order for as long as a job stays active.
 */
const SHARED_WIDGET_KEY = "legion:jobs";

export function createDispatchTool(
	resolveService: DispatchServiceResolver,
): ToolDefinition<typeof dispatchRequestSchema, LegionDispatchDetails> {
	const activeJobs = new Map<string, JobWidgetEntry>();

	function renderJobs(context: ExtensionContext, frame: number): void {
		if (!context?.ui?.setWidget) return;
		if (activeJobs.size === 0) {
			context.ui.setWidget(SHARED_WIDGET_KEY, undefined);
			return;
		}
		// Snapshot now rather than closing over the live, mutable `activeJobs`
		// map: this factory may not be invoked by the host until sometime
		// after this call returns, by which point a job could already have
		// completed and been removed. Capturing here makes each render call
		// deterministic for exactly the state at that moment.
		const snapshot = [...activeJobs.values()];
		context.ui.setWidget(
			SHARED_WIDGET_KEY,
			(_tui, theme) => {
				const container = new Container();
				for (const entry of snapshot) {
					// Task/plan/models already sit in the persisted tool-call card
					// below; this ephemeral widget only shows what's actually live —
					// which phase, how long, and (if reported) what's happening in it.
					const elapsedSec = Math.floor((Date.now() - entry.startedAt) / 1000);
					const elapsed = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
					const header = `${spinnerChar(frame)} Legion (${entry.jobLabel}) | ${elapsed}`;
					const status = `[${entry.label}] ${entry.detail}`;
					const box = new Box(1, 0, undefined, boxBorder(theme, "accent"));
					box.addChild(
						new Text(
							theme.fg?.("accent", theme.bold?.(header) ?? header) ?? header,
							0,
							0,
						),
					);
					box.addChild(new Text(theme.fg?.("muted", status) ?? status, 0, 0));
					container.addChild(box);
				}
				return container;
			},
			{ placement: "aboveEditor" },
		);
	}

	function monitorWidget(
		accepted: ReturnType<DispatchService["dispatch"]>,
		service: DispatchService,
		context: ExtensionContext,
	): void {
		if (!context?.ui?.setWidget) return;
		// The job's own human-readable slug, stripped of the "legion-" prefix
		// already implied by the "Legion" row heading — without this, two or
		// more concurrent rows (a genuinely multi-part dispatch fanning out
		// into several legion_dispatch calls) render identically, and a user
		// watching live has no way to tell which is which (confirmed live).
		const jobLabel = shortAgentName(accepted.jobId);
		activeJobs.set(accepted.jobId, {
			jobLabel,
			startedAt: Date.now(),
			label: "QUEUED",
			detail: "waiting to start",
		});

		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			spinner.stop();
			activeJobs.delete(accepted.jobId);
			renderJobs(context, 0);
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
			const entry = activeJobs.get(accepted.jobId);
			if (entry) {
				entry.label = label;
				entry.detail = detail;
			}
			renderJobs(context, frame);
		});
		void (async () => {
			while (!closed) {
				const job = service.getJob(accepted.jobId);
				if (
					job?.status === "completed" ||
					job?.status === "failed" ||
					job?.status === "cancelled"
				) {
					close();
					return;
				}
				await sleep(200);
			}
		})().catch((error) => {
			console.warn(
				"Legion background progress monitor stopped unexpectedly.",
				error,
			);
			close();
		});
	}
	return {
		name: "legion_dispatch",
		label: "Legion",
		description:
			"Run one task through several independent expert attempts in parallel, then wait for and return a synthesized, cross-checked answer. Call for judgment calls, security-sensitive changes, subtle correctness bugs, architecture decisions, or any case where a second opinion is worth the latency and cost; do not use for routine low-stakes work that can be handled directly. The call blocks until decomposition, expert execution, synthesis, and any human governance resolve. Never call Legion from inside a task it dispatched. Omit `tasks` for automatic decomposition, or provide explicit tasks when the split is known. For explicit tasks, each `role` must be a bare role name matching an available legion persona (for example, `reviewer` or `coder`); capitalized names and prefixed names such as `legion-reviewer` are rejected. Each task's `assignment` is the actual instruction the expert receives and acts on; the request-level `task` is secondary background context for every expert.",
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
			const job = service.getJob(accepted.jobId);
			if (!job) {
				return finalResult(
					buildDetails(accepted, "failed"),
					`Legion dispatch job ${accepted.jobId} could not be found.`,
					true,
				);
			}
			try {
				await waitForDispatch(job, service, accepted.jobId, signal);
			} catch (error) {
				if (signal?.aborted)
					return finalResult(emptyDetails(), undefined, true);
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("Legion dispatch timed out after ")) {
					return finalResult(buildDetails(accepted, "failed"), message, true);
				}
				return finalResult(
					buildDetails(accepted, "failed"),
					`Legion dispatch failed: ${message}`,
					true,
				);
			}
			const completed = service.getJob(accepted.jobId);
			const resultText = completed?.resultText;
			const progressDetails = completed?.lastProgressDetails;
			const successfulAttemptCount =
				typeof progressDetails?.successfulAttemptCount === "number"
					? progressDetails.successfulAttemptCount
					: 0;
			const synthesisSucceeded = progressDetails?.synthesisSucceeded === true;
			return finalResult(
				buildDetails(
					accepted,
					"completed",
					resultText,
					successfulAttemptCount,
					synthesisSucceeded,
				),
				resultText,
			);
		},
		renderCall: () => EMPTY_COMPONENT,
		renderResult: (result, options, theme, args) =>
			renderDispatchResult(result, options, theme, args),
	};
}
