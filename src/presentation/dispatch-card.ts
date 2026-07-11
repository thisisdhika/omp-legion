import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";

import type { DispatchRequest } from "../domain/dispatch";
import type { LegionDispatchDetails } from "./dispatch-tool";

const TASK_PREVIEW_LENGTH = 60;

function header(theme: Theme, icon: string, title: string): string {
	const text = `${icon}  ${title}`;
	return theme.fg?.("accent", theme.bold?.(text) ?? text) ?? text;
}

/** Same visual language as the screenshot you liked — "├─"/"└─" tree rows. */
function treeLines(rows: readonly string[]): string {
	return rows
		.map((row, index) => `${index === rows.length - 1 ? "└─" : "├─"} ${row}`)
		.join("\n");
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function renderDispatchCall(
	args: DispatchRequest,
	theme: Theme,
): Container {
	const card = new Container();
	card.addChild(
		new Text(
			header(theme, theme.icon?.extensionTool || "⌘", "Legion Dispatch"),
			0,
			0,
		),
	);

	const rows = [`task: "${truncate(args.task, TASK_PREVIEW_LENGTH)}"`];
	if (args.tasks?.length) {
		rows.push(`tasks: ${args.tasks.length} explicit`);
		for (const task of args.tasks) rows.push(`  ${task.id} (${task.role})`);
	} else {
		rows.push("tasks: auto-decompose");
	}
	const modelMapKeys = Object.keys(args.modelMap ?? {});
	if (modelMapKeys.length > 0)
		rows.push(`modelMap: ${modelMapKeys.join(", ")}`);

	card.addChild(new Text(treeLines(rows), 0, 0));
	return card;
}

export function renderDispatchResult(
	result: AgentToolResult<LegionDispatchDetails>,
	theme: Theme,
): Container {
	const card = new Container();
	const icon = result.isError
		? theme.icon?.warning || "⚠"
		: theme.icon?.extensionTool || "⌘";
	card.addChild(new Text(header(theme, icon, "Legion Dispatch"), 0, 0));

	const details = result.details;
	if (result.isError || !details) {
		const first = result.content?.[0];
		const message =
			first && first.type === "text" ? first.text : "Dispatch failed.";
		card.addChild(new Text(theme.fg?.("error", message) ?? message, 0, 0));
		return card;
	}

	const rows = [
		`job: ${details.jobId}`,
		`attempts: ${details.attemptCount}`,
		`models: ${[...new Set(details.attemptModels)].join(", ")}`,
		"results deliver asynchronously",
	];
	card.addChild(new Text(treeLines(rows), 0, 0));
	return card;
}
