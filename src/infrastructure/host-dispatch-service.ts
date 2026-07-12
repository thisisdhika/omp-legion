import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import {
	DispatchService,
	type DispatchServiceOptions,
} from "../application/dispatch-service";
import type { LegionConfig } from "../domain/config";
import {
	HOTL_DECISION_ACTIONS,
	HOTL_DECISION_APPROVE,
	HOTL_DECISION_EDIT,
	HOTL_DECISION_REJECT,
	HOTL_DECISION_TITLE,
	HOTL_EDIT_PLACEHOLDER,
	HOTL_EDIT_TITLE,
	HOTL_EMPTY_EDIT_MESSAGE,
	HOTL_NO_DECISION_PROVIDER_MESSAGE,
} from "../domain/constants";
import { resolveAgentName } from "../domain/dispatch";
import { SynthesisService } from "../domain/synthesis";
import { HostBranchMerger } from "./branch-merger";
import { HostEmbeddingProvider } from "./embedding-provider";
import { HostExpertExecutor, HostJobScheduler } from "./host-dispatcher";
import { createHostOrchestrationRepository } from "./host-orchestration-repository";
import { HostLlmAggregator } from "./llm-aggregator";
import { HostLlmDecomposer } from "./llm-decomposer";
import { HostVerifier } from "./verifier";

function activeModel(ctx: ExtensionContext) {
	return ctx.models.current() ?? ctx.model;
}

function activeModelSelector(ctx: ExtensionContext): string | undefined {
	const model = activeModel(ctx);
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function createHostDispatchService(
	ctx: ExtensionContext,
	config: LegionConfig,
	agents: ReadonlyMap<string, AgentDefinition>,
	eventBus?: ExecutorOptions["eventBus"],
): DispatchService {
	const manager = AsyncJobManager.instance();
	if (!manager) throw new Error("Legion requires the host async job manager.");
	const model = activeModel(ctx);
	if (!model)
		throw new Error("Legion requires an active model for aggregation.");

	const sessionFile = ctx.sessionManager.getSessionFile();
	const agentNames = new Set(agents.keys());
	const options: DispatchServiceOptions = {
		scheduler: new HostJobScheduler(manager),
		executor: new HostExpertExecutor({
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			sessionFile,
			artifactsDir: ctx.sessionManager.getArtifactsDir() ?? undefined,
			parentArtifactManager:
				ctx.sessionManager.getArtifactManager() ?? undefined,
			parentActiveModelPattern: activeModelSelector(ctx),
			agents,
			eventBus,
		}),
		resolveAgent: (role) => resolveAgentName(role, agentNames),
		synthesizer: new SynthesisService({
			embeddingProvider: new HostEmbeddingProvider({
				...config.embedding,
				modelRegistry: ctx.modelRegistry,
			}),
			aggregator: new HostLlmAggregator({
				model,
				modelRegistry: ctx.modelRegistry,
				cwd: ctx.cwd,
			}),
		}),
		repository: createHostOrchestrationRepository(ctx.sessionManager),
		decomposer: new HostLlmDecomposer({
			model,
			modelRegistry: ctx.modelRegistry,
			cwd: ctx.cwd,
		}),
		config,
		defaultModel: activeModelSelector(ctx),
		governanceThresholds: config.hotl,
		decisionTimeoutMs: config.decisionTimeoutMs,
		maxConcurrentExperts: config.maxConcurrentExperts,
		branchMerger: new HostBranchMerger({ cwd: ctx.cwd }),
		verifier: config.verifyCommand
			? new HostVerifier({ cwd: ctx.cwd, command: config.verifyCommand })
			: undefined,
		isModelAvailable: (selector) => ctx.models.resolve(selector) !== undefined,
		notifyEscalation: ({ jobId, taskId, decision }) => {
			ctx.ui.notify(
				`Legion escalation for ${jobId}/${taskId}: ${decision.reasons.join(", ")}`,
				"warning",
			);
		},
		decisionGate: async (_notice, signal) => {
			if (!ctx.hasUI) {
				return {
					action: HOTL_DECISION_REJECT,
					note: HOTL_NO_DECISION_PROVIDER_MESSAGE,
				};
			}
			const action = await ctx.ui.select(
				HOTL_DECISION_TITLE,
				[...HOTL_DECISION_ACTIONS],
				{ signal },
			);
			if (action === HOTL_DECISION_APPROVE)
				return { action: HOTL_DECISION_APPROVE };
			if (action !== HOTL_DECISION_EDIT)
				return { action: HOTL_DECISION_REJECT };
			const note = await ctx.ui.input(HOTL_EDIT_TITLE, HOTL_EDIT_PLACEHOLDER, {
				signal,
			});
			return note?.trim()
				? { action: HOTL_DECISION_EDIT, note: note.trim() }
				: { action: HOTL_DECISION_REJECT, note: HOTL_EMPTY_EDIT_MESSAGE };
		},
	};
	return new DispatchService(options);
}
