import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	Theme,
	ThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolUIStatus } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import {
	framedBlock,
	outputBlockContentWidth,
	renderStatusLine,
} from "@oh-my-pi/pi-coding-agent/tui";
import type { BoxBorder, Component, MarkdownTheme } from "@oh-my-pi/pi-tui";
import { Markdown } from "@oh-my-pi/pi-tui";

import type { TaskAttemptSummary } from "../application/dispatch-service";
import type { DispatchRequest } from "../domain/dispatch";
import { shortAgentName } from "../domain/dispatch";
import type { LegionDispatchDetails } from "./dispatch-tool";

/** Rounded-corner fallback for lightweight Theme doubles (e.g. in tests) that don't implement boxRound. */
const FALLBACK_BOX_CHARS = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

/**
 * Parameterized by the `theme` renderResult actually receives, unlike
 * pi-coding-agent's getMarkdownTheme() which reads a global theme singleton
 * — that diverges under render-time theme overrides (and under test doubles,
 * which don't initialize the global at all).
 */
function buildMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg?.("mdHeading", text) ?? text,
		link: (text) => theme.fg?.("mdLink", text) ?? text,
		linkUrl: (text) => theme.fg?.("mdLinkUrl", text) ?? text,
		code: (text) => theme.fg?.("mdCode", text) ?? text,
		codeBlock: (text) => theme.fg?.("mdCodeBlock", text) ?? text,
		codeBlockBorder: (text) => theme.fg?.("mdCodeBlockBorder", text) ?? text,
		quote: (text) => theme.fg?.("mdQuote", text) ?? text,
		quoteBorder: (text) => theme.fg?.("mdQuoteBorder", text) ?? text,
		hr: (text) => theme.fg?.("mdHr", text) ?? text,
		listBullet: (text) => theme.fg?.("mdListBullet", text) ?? text,
		bold: (text) => theme.bold?.(text) ?? text,
		italic: (text) => theme.italic?.(text) ?? text,
		strikethrough: (text) => theme.fg?.("muted", text) ?? text,
		underline: (text) => theme.underline?.(text) ?? text,
		symbols: {
			cursor: "▏",
			inputCursor: "▏",
			boxRound: theme.boxRound ?? FALLBACK_BOX_CHARS,
			boxSharp: theme.boxSharp ?? {
				...FALLBACK_BOX_CHARS,
				topLeft: "┌",
				topRight: "┐",
				bottomLeft: "└",
				bottomRight: "┘",
				cross: "┼",
				teeDown: "┬",
				teeUp: "┴",
				teeRight: "├",
				teeLeft: "┤",
			},
			table: theme.boxSharp ?? {
				topLeft: "┌",
				topRight: "┐",
				bottomLeft: "└",
				bottomRight: "┘",
				horizontal: "─",
				vertical: "│",
				cross: "┼",
				teeDown: "┬",
				teeUp: "┴",
				teeRight: "├",
				teeLeft: "┤",
			},
			quoteBorder: "┃",
			hrChar: "─",
			spinnerFrames: theme.spinnerFrames ?? [
				"⠋",
				"⠙",
				"⠹",
				"⠸",
				"⠼",
				"⠴",
				"⠦",
				"⠧",
				"⠇",
				"⠏",
			],
		},
	};
}

/** A rounded, single-color-tinted border matching the active theme's box glyphs. */
export function boxBorder(theme: Theme, color: ThemeColor): BoxBorder {
	return {
		chars: theme.boxRound ?? FALLBACK_BOX_CHARS,
		color: (text: string) => theme.fg?.(color, text) ?? text,
	};
}

export interface TreeNode {
	readonly label: string;
	readonly children?: readonly TreeNode[];
}

/**
 * A real tree: each node gets its own "├─"/"└─" connector, and children are
 * indented under a continuation prefix ("│  " when their parent isn't the
 * last sibling, "   " when it is) — not just extra leading spaces on an
 * otherwise-flat line, which is what the first attempt at this did.
 */
function renderTree(nodes: readonly TreeNode[], prefix = ""): string[] {
	const lines: string[] = [];
	nodes.forEach((node, index) => {
		const isLast = index === nodes.length - 1;
		lines.push(`${prefix}${isLast ? "└─" : "├─"} ${node.label}`);
		if (node.children?.length) {
			const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
			lines.push(...renderTree(node.children, childPrefix));
		}
	});
	return lines;
}

export const MIXTURES_SECTION_LABEL = "Mixtures";

/**
 * "~N models" rather than "N": Legion's runtime fallback/adaptive-expansion
 * can add more attempts (and swap in a different model) after this snapshot
 * was taken, so the count shown here is a floor, not a final tally.
 *
 * Counts *distinct* model identifiers, not raw attempts — a role dispatched
 * across two tasks with the same 3-model ensemble is still 3 models, not 6;
 * summing attempt counts instead of deduping models previously showed "~6
 * models" for exactly that case (confirmed live), overstating the ensemble's
 * actual model diversity.
 */
function modelCountLabel(models: readonly string[]): string {
	const distinct = new Set(models).size;
	return `~${distinct} model${distinct === 1 ? "" : "s"}`;
}

/**
 * Attempts grouped by dispatched agent (persona) rather than by internal
 * task id — regardless of whether the breakdown came from explicit `tasks`,
 * real auto-decomposition, or the common single-generic-task ensemble, what
 * a human wants to know is "which personas are working on this, and how
 * many," not the task-id bookkeeping underneath. Two tasks that happen to
 * resolve to the same agent (e.g. duplicate roles) merge into one line with
 * combined counts — still an accurate answer to that question. Doesn't list
 * the actual model names: which model backs a given attempt can change out
 * from under this snapshot via the same expansion that grows the count, so
 * naming them here would read as more settled than it is.
 */
function expertsByAgentNodes(
	taskBreakdown: readonly TaskAttemptSummary[],
): TreeNode[] {
	const modelsByAgent = new Map<string, string[]>();
	for (const summary of taskBreakdown) {
		const models = modelsByAgent.get(summary.agent) ?? [];
		models.push(...summary.models);
		modelsByAgent.set(summary.agent, models);
	}
	return [...modelsByAgent.entries()].map(([agent, models]) => ({
		label: `${shortAgentName(agent)}: ${modelCountLabel(models)}`,
	}));
}

/**
 * Tree nodes for a request's task assignments, used only on the error card —
 * `dispatch()` never reaches planning before an error, so there's no
 * `taskBreakdown` to group by agent yet, only whatever explicit `tasks` the
 * caller supplied (if any).
 */
function requestNodes(args: DispatchRequest | undefined): TreeNode[] {
	if (!args) return [];
	const nodes: TreeNode[] = [];
	if (args.tasks?.length) {
		nodes.push({
			label: `assignments: ${args.tasks.length} explicit`,
			children: args.tasks.map((task) => ({
				label: `${task.id} (${task.role})`,
			})),
		});
	}
	const modelMapKeys = Object.keys(args.modelMap ?? {});
	if (modelMapKeys.length > 0)
		nodes.push({ label: `modelMap: ${modelMapKeys.join(", ")}` });
	return nodes;
}

/**
 * The job reference plus the experts breakdown. "ref" rather than "job":
 * "job" read as a peer of "Task" (as in, another description of the work),
 * when it's really just an id pointing at the same task described above —
 * and matches what shows up in escalation/completion messages elsewhere in
 * the transcript, for cross-referencing.
 */
function metadataNodes(
	args: DispatchRequest | undefined,
	details: LegionDispatchDetails,
	theme: Theme,
): TreeNode[] {
	const refLabel = `ref: ${details.jobId}`;
	const nodes: TreeNode[] = [
		{ label: theme.fg?.("muted", refLabel) ?? refLabel },
	];
	// Only trust taskBreakdown's agent for a per-agent breakdown when the
	// caller supplied explicit `tasks` — that's a real request. Auto-decompose
	// has no explicit tasks, so dispatch()'s synchronous preview (what this
	// card renders) always resolves a generic placeholder role/agent via
	// fallbackDecomposition; the real decomposer only runs later, in the
	// background job, and can (often does) pick something more specific —
	// naming the placeholder here would show a guess as though it were final.
	if ((args?.tasks?.length ?? 0) > 0 && details.taskBreakdown.length > 0) {
		nodes.push({
			label: "experts:",
			children: expertsByAgentNodes(details.taskBreakdown),
		});
	} else {
		nodes.push({ label: `experts: ${modelCountLabel(details.attemptModels)}` });
	}
	const modelMapKeys = Object.keys(args?.modelMap ?? {});
	if (modelMapKeys.length > 0)
		nodes.push({ label: `modelMap: ${modelMapKeys.join(", ")}` });
	return nodes;
}

type Section = { label?: string; lines: readonly string[] };

/** Pre-render markdown to lines sized for the frame's inner content width, matching the built-in `task` tool's own section pattern (see its createMarkdownSectionRenderer). */
function markdownSection(
	label: string,
	text: string,
	theme: Theme,
): (width: number) => Section {
	const markdown = new Markdown(text, 0, 0, buildMarkdownTheme(theme));
	return (width) => ({
		label,
		lines: markdown.render(Math.max(1, outputBlockContentWidth(width))),
	});
}

/** The task's full text as its own section — deliberately not truncated (unlike the plan tree's other fields) and markdown-parsed (task descriptions often carry code fences, lists, etc. that should render, not print as literal ``` characters), outside the tree so long assignments stay readable instead of clipped to a bullet line. */
function taskSection(
	args: DispatchRequest | undefined,
	theme: Theme,
): ((width: number) => Section) | undefined {
	if (!args) return undefined;
	return markdownSection("Task", args.task, theme);
}

/**
 * A single combined card covering both the request and the immediate accept
 * response, built on the same `framedBlock`/`renderStatusLine` primitives the
 * built-in `task` tool uses — so Legion's card reads as a native block
 * (bordered, state-colored, titled sections) instead of a bespoke widget.
 * renderCall + renderResult on the same tool render as two separately-headed
 * blocks stacked on top of each other, not one merged card — the same
 * platform quirk the predecessor project hit and fixed by dropping
 * renderCall entirely (see its D-2.6 note). renderResult's args parameter
 * carries everything renderCall would have shown.
 */
export function renderDispatchResult(
	result: AgentToolResult<LegionDispatchDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	args?: DispatchRequest,
): Component {
	const details = result.details;

	// --- Partial / live progress card ---
	if (options.isPartial) {
		const progressText = result.content?.[0];
		// buildProgressText() already prefixes its own spinner glyph and
		// trailing ellipsis; strip both since renderStatusLine draws its own
		// (render-time-accurate) spinner via icon+spinnerFrame below.
		const description =
			progressText && progressText.type === "text"
				? progressText.text.replace(/^\S+\s/, "").replace(/…$/, "")
				: "Dispatching";
		const liveDetails: LegionDispatchDetails = details ?? {
			jobId: "",
			recordId: "",
			state: "running",
			attemptCount: 0,
			attemptModels: [],
			taskBreakdown: [],
		};
		const buildTaskSection = taskSection(args, theme);
		return framedBlock(theme, (width) => {
			const sections: Section[] = [];
			if (buildTaskSection) sections.push(buildTaskSection(width));
			sections.push({
				label: MIXTURES_SECTION_LABEL,
				lines: renderTree(metadataNodes(args, liveDetails, theme)),
			});
			return {
				header: renderStatusLine(
					{
						icon: "running" satisfies ToolUIStatus,
						spinnerFrame: options.spinnerFrame,
						title: "Legion",
						description,
					},
					theme,
				),
				sections,
				state: "running",
				width,
			};
		});
	}

	if (details && details.state === "running") {
		const buildTaskSection = taskSection(args, theme);
		return framedBlock(theme, (width) => {
			const sections: Section[] = [];
			if (buildTaskSection) sections.push(buildTaskSection(width));
			sections.push({
				label: MIXTURES_SECTION_LABEL,
				lines: renderTree(metadataNodes(args, details, theme)),
			});
			return {
				header: renderStatusLine(
					{
						icon: "running" satisfies ToolUIStatus,
						title: "Legion",
						description: "running in background",
					},
					theme,
				),
				sections,
				state: "running",
				width,
			};
		});
	}

	// --- Final result card ---
	if (result.isError || !details) {
		const first = result.content?.[0];
		const message =
			first && first.type === "text" ? first.text : "Dispatch failed.";
		const buildTaskSection = taskSection(args, theme);
		return framedBlock(theme, (width) => {
			const sections: Section[] = [];
			if (buildTaskSection) sections.push(buildTaskSection(width));
			sections.push({
				label: "Error",
				lines: renderTree([
					...requestNodes(args),
					{ label: theme.fg?.("error", message) ?? message },
				]),
			});
			return {
				header: renderStatusLine(
					{
						icon: "error" satisfies ToolUIStatus,
						title: "Legion",
						description: "dispatch failed",
					},
					theme,
				),
				sections,
				state: "error",
				width,
			};
		});
	}

	const resultText = details.resultText;
	const buildTaskSection = taskSection(args, theme);
	const buildResultSection = resultText
		? markdownSection("Result", resultText, theme)
		: undefined;
	return framedBlock(theme, (width) => {
		const sections: Section[] = [];
		if (buildTaskSection) sections.push(buildTaskSection(width));
		sections.push({
			label: MIXTURES_SECTION_LABEL,
			lines: renderTree(metadataNodes(args, details, theme)),
		});
		if (buildResultSection) sections.push(buildResultSection(width));
		return {
			header: renderStatusLine(
				{
					icon: "success" satisfies ToolUIStatus,
					title: "Legion",
					description: "synthesis complete",
				},
				theme,
			),
			sections,
			state: "success",
			width,
		};
	});
}
