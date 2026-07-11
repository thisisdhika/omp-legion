import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";

import type { TaskAttemptSummary } from "../application/dispatch-service";
import type { DispatchRequest } from "../domain/dispatch";
import type { LegionDispatchDetails } from "./dispatch-tool";

const TASK_PREVIEW_LENGTH = 60;

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

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function taskAttemptNodes(
	summary: TaskAttemptSummary | undefined,
): TreeNode[] | undefined {
	if (!summary) return undefined;
	return [
		{ label: `attempts: ${summary.attemptCount}` },
		{ label: `models: ${[...new Set(summary.models)].join(", ")}` },
	];
}

function requestNodes(
	args: DispatchRequest | undefined,
	taskBreakdown: readonly TaskAttemptSummary[] = [],
): TreeNode[] {
	if (!args) return [];
	const nodes: TreeNode[] = [
		{ label: `task: "${truncate(args.task, TASK_PREVIEW_LENGTH)}"` },
	];
	nodes.push(
		args.tasks?.length
			? {
					label: `tasks: ${args.tasks.length} explicit`,
					children: args.tasks.map((task) => ({
						label: `${task.id} (${task.role})`,
						children: taskAttemptNodes(
							taskBreakdown.find((summary) => summary.taskId === task.id),
						),
					})),
				}
			: { label: "tasks: auto-decompose" },
	);
	const modelMapKeys = Object.keys(args.modelMap ?? {});
	if (modelMapKeys.length > 0)
		nodes.push({ label: `modelMap: ${modelMapKeys.join(", ")}` });
	return nodes;
}

/**
 * A single combined card covering both the request and the immediate accept
 * response. renderCall + renderResult on the same tool render as two
 * separately-headed blocks stacked on top of each other, not one merged
 * card — the same platform quirk the predecessor project hit and fixed by
 * dropping renderCall entirely (see its D-2.6 note). renderResult's args
 * parameter carries everything renderCall would have shown.
 */
export function renderDispatchResult(
	result: AgentToolResult<LegionDispatchDetails>,
	theme: Theme,
	args?: DispatchRequest,
): Container {
	// No title/header line here — the host already renders one above every
	// tool block from the tool's own `label` ("Legion"). Adding another one
	// here duplicated it; this card is body-only.
	const card = new Container();
	const details = result.details;
	if (result.isError || !details) {
		const first = result.content?.[0];
		const message =
			first && first.type === "text" ? first.text : "Dispatch failed.";
		const nodes = [
			...requestNodes(args),
			{ label: theme.fg?.("error", message) ?? message },
		];
		card.addChild(new Text(renderTree(nodes).join("\n"), 0, 0));
		return card;
	}

	// Explicit tasks already carry their own attempts/models as children (see
	// requestNodes); only auto-decompose (no task breakdown known yet at
	// request time) needs the aggregate shown as flat top-level lines.
	const nodes: TreeNode[] = [
		...requestNodes(args, details.taskBreakdown),
		{ label: `job: ${details.jobId}` },
		...(details.taskBreakdown.length > 0
			? []
			: [
					{ label: `attempts: ${details.attemptCount}` },
					{
						label: `models: ${[...new Set(details.attemptModels)].join(", ")}`,
					},
				]),
		{ label: "results deliver asynchronously" },
	];
	card.addChild(new Text(renderTree(nodes).join("\n"), 0, 0));
	return card;
}
