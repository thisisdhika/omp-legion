import { describe, expect, test } from "bun:test";

import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type {
	ExecutorOptions,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type {
	AgentDefinition,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent/task/types";

import type { DecomposerPolicy } from "../../src/domain/config";
import type { DecomposerAuditEvent } from "../../src/domain/decomposition";
import { DECOMPOSER_SYSTEM_PROMPT } from "../../src/infrastructure/aggregator-prompts";
import { HostLlmDecomposer } from "../../src/infrastructure/llm-decomposer";

type Behavior = "ok" | "fail" | "empty" | "no-output";

const SUCCESS_JSON = '{"tasks":[{"id":"t1","role":"coder","assignment":"x"}]}';

function fakeModel(id: string): Model<Api> {
	return { provider: "prov", id } as unknown as Model<Api>;
}

const stubRegistry = {
	find: (_provider: string, id: string) => (id ? fakeModel(id) : undefined),
	resolver: () => () => "key",
} as unknown as ModelRegistry;

const stubAgent: AgentDefinition = {
	name: "legion-decomposer",
	description: "test double",
	systemPrompt: "test system prompt",
	tools: ["read", "grep", "glob"],
	source: "bundled",
};

function makeResult(overrides: Partial<SingleResult>): SingleResult {
	return {
		index: 0,
		id: "id",
		agent: "legion-decomposer",
		agentSource: "bundled",
		task: "task",
		exitCode: 0,
		output: SUCCESS_JSON,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		...overrides,
	};
}

type RunFn = typeof runSubprocess;

function makeRunSubprocess(behaviors: Record<string, Behavior>) {
	let inFlight = 0;
	let maxInFlight = 0;
	const calls: string[] = [];
	const run: RunFn = async (options: ExecutorOptions) => {
		if (options.signal?.aborted) throw new Error("aborted by signal");
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		inFlight -= 1;
		const selector = options.modelOverride as string;
		calls.push(selector);
		const behavior = behaviors[selector] ?? "ok";
		if (behavior === "fail") throw new Error(`provider error for ${selector}`);
		if (behavior === "empty") return makeResult({ output: '{"tasks":[]}' });
		if (behavior === "no-output") return makeResult({ output: "" });
		return makeResult({ output: SUCCESS_JSON });
	};
	return {
		run,
		calls: () => calls,
		maxInFlight: () => maxInFlight,
	};
}

function makeDecomposer(opts: {
	policy?: DecomposerPolicy;
	behaviors: Record<string, Behavior>;
	resolveModel?: (selector: string) => Model<Api> | undefined;
	budget?: { maxAttempts?: number };
	activeId?: string;
}) {
	const { run, calls, maxInFlight } = makeRunSubprocess(opts.behaviors);
	const auditEvents: DecomposerAuditEvent[] = [];
	const decomposer = new HostLlmDecomposer({
		model: fakeModel(opts.activeId ?? "active"),
		modelRegistry: stubRegistry,
		cwd: "/tmp",
		policy: opts.policy,
		resolveModel: opts.resolveModel ?? ((selector) => fakeModel(selector)),
		budget: opts.budget,
		audit: (event) => auditEvents.push(event),
		agent: stubAgent,
		runSubprocess: run,
	});
	return { decomposer, auditEvents, calls, maxInFlight };
}

describe("HostLlmDecomposer sequential fallback", () => {
	test("advances to the next model on a retryable provider failure", async () => {
		const { decomposer, auditEvents, calls, maxInFlight } = makeDecomposer({
			policy: {
				models: ["fail", "good", "backup"],
				temperatureLadder: [0.2, 0.6, 1.0],
			},
			behaviors: { fail: "fail", good: "ok", backup: "ok" },
		});
		const tasks = await decomposer.decompose({ task: "do" });
		expect(tasks[0]?.id).toBe("t1");
		expect(calls()).toEqual(["fail", "good"]); // backup never reached
		expect(maxInFlight()).toBe(1); // no parallelism
		expect(auditEvents.map((event) => [event.selector, event.status])).toEqual([
			["fail", "retryable-failure"],
			["good", "success"],
		]);
	});

	test("never runs models in parallel or duplicates a selector", async () => {
		const { decomposer, calls } = makeDecomposer({
			policy: { models: ["fail", "fail", "good"], temperatureLadder: [0.2] },
			behaviors: { fail: "fail", good: "ok" },
		});
		await decomposer.decompose({ task: "do" });
		// "fail" attempted once despite appearing twice; "good" once.
		expect(calls().filter((id) => id === "fail")).toHaveLength(1);
		expect(calls()).toEqual(["fail", "good"]);
	});

	test("exhausts all candidates and reports every failure", async () => {
		const { decomposer, auditEvents, calls } = makeDecomposer({
			policy: { models: ["a", "b"], temperatureLadder: [0.2] },
			behaviors: { a: "fail", b: "fail" },
		});
		await expect(decomposer.decompose({ task: "do" })).rejects.toThrow(
			/exhausted/i,
		);
		expect(calls()).toEqual(["a", "b"]);
		expect(auditEvents.map((event) => event.status)).toEqual([
			"retryable-failure",
			"retryable-failure",
		]);
	});

	test("respects a configured attempt budget", async () => {
		const { decomposer, calls } = makeDecomposer({
			policy: { models: ["a", "b", "c"], temperatureLadder: [0.2] },
			behaviors: { a: "fail", b: "fail", c: "fail" },
			budget: { maxAttempts: 2 },
		});
		await expect(decomposer.decompose({ task: "do" })).rejects.toThrow(
			/exhausted/i,
		);
		expect(calls()).toEqual(["a", "b"]); // c never attempted
	});

	test("cancels without advancing when the signal is already aborted", async () => {
		const { decomposer, auditEvents, calls } = makeDecomposer({
			policy: { models: ["slow"], temperatureLadder: [0.2] },
			behaviors: { slow: "ok" },
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			decomposer.decompose({ task: "do", signal: controller.signal }),
		).rejects.toThrow(/cancelled/i);
		expect(calls()).toEqual([]);
		expect(auditEvents[0]?.status).toBe("cancelled");
	});

	test("does not retry a validation (parse) failure on the next model", async () => {
		const { decomposer, calls } = makeDecomposer({
			policy: { models: ["bad", "good"], temperatureLadder: [0.2] },
			behaviors: { bad: "empty", good: "ok" },
		});
		await expect(decomposer.decompose({ task: "do" })).rejects.toThrow(
			/invalid task JSON/i,
		);
		expect(calls()).toEqual(["bad"]); // good never attempted
	});

	test("treats a subagent run that produced no output as a retryable failure", async () => {
		const { decomposer, calls } = makeDecomposer({
			policy: { models: ["silent", "good"], temperatureLadder: [0.2] },
			behaviors: { silent: "no-output", good: "ok" },
		});
		const tasks = await decomposer.decompose({ task: "do" });
		expect(tasks[0]?.id).toBe("t1");
		expect(calls()).toEqual(["silent", "good"]);
	});

	test("records an unavailable selector and moves on", async () => {
		const { decomposer, auditEvents, calls } = makeDecomposer({
			policy: { models: ["missing", "good"], temperatureLadder: [0.2] },
			behaviors: { good: "ok" },
			resolveModel: (selector) =>
				selector === "missing" ? undefined : fakeModel(selector),
		});
		const tasks = await decomposer.decompose({ task: "do" });
		expect(tasks[0]?.id).toBe("t1");
		expect(calls()).toEqual(["good"]);
		expect(auditEvents.map((event) => [event.selector, event.status])).toEqual([
			["missing", "unavailable"],
			["good", "success"],
		]);
	});

	test("falls back to the active session model when no policy is configured", async () => {
		const { decomposer, auditEvents, calls } = makeDecomposer({
			activeId: "activesession",
			behaviors: { "prov/activesession": "ok" },
		});
		const tasks = await decomposer.decompose({ task: "do" });
		expect(tasks[0]?.id).toBe("t1");
		expect(calls()).toEqual(["prov/activesession"]);
		expect(auditEvents[0]).toMatchObject({
			selector: "prov/activesession",
			status: "success",
		});
	});
});

describe("HostLlmDecomposer agent/roster wiring", () => {
	// The real agent definition comes from the bundled/overridable
	// agents/legion-decomposer.md persona (see host-dispatch-service.ts) —
	// this locks in that HostLlmDecomposer actually runs whatever agent it
	// was given (systemPrompt AND tools), rather than a hardcoded fallback.
	function captureRunOptions() {
		const seen: ExecutorOptions[] = [];
		const run: RunFn = async (options: ExecutorOptions) => {
			seen.push(options);
			return makeResult({ output: SUCCESS_JSON });
		};
		return { run, seen };
	}

	test("runs the injected agent definition, tools and all", async () => {
		const { run, seen } = captureRunOptions();
		const customAgent: AgentDefinition = {
			name: "legion-decomposer",
			description: "custom",
			systemPrompt: "custom project-overridden decomposer instructions",
			tools: ["read", "grep", "glob"],
			source: "project",
		};
		const decomposer = new HostLlmDecomposer({
			model: fakeModel("active"),
			modelRegistry: stubRegistry,
			cwd: "/tmp",
			agent: customAgent,
			runSubprocess: run,
		});

		await decomposer.decompose({ task: "do" });

		expect(seen[0]?.agent).toBe(customAgent);
	});

	test("falls back to a built-in agent (with read/grep/glob) when none is provided", async () => {
		const { run, seen } = captureRunOptions();
		const decomposer = new HostLlmDecomposer({
			model: fakeModel("active"),
			modelRegistry: stubRegistry,
			cwd: "/tmp",
			runSubprocess: run,
		});

		await decomposer.decompose({ task: "do" });

		const agent = seen[0]?.agent;
		expect(agent?.tools).toEqual(["read", "grep", "glob"]);
		expect(agent?.systemPrompt).toContain(DECOMPOSER_SYSTEM_PROMPT[0]);
	});

	test("threads the real available-roles roster through as executor context", async () => {
		const { run, seen } = captureRunOptions();
		const decomposer = new HostLlmDecomposer({
			model: fakeModel("active"),
			modelRegistry: stubRegistry,
			cwd: "/tmp",
			runSubprocess: run,
			availableRoles: [
				{ role: "coder", description: "Implementation specialist." },
				{ role: "security-auditor", description: "Custom project persona." },
			],
		});

		await decomposer.decompose({ task: "do" });

		expect(seen[0]?.context).toContain("security-auditor");
		expect(seen[0]?.context).toContain("Custom project persona.");
	});

	test("doesn't set an empty context block when no roles are available", async () => {
		const { run, seen } = captureRunOptions();
		const decomposer = new HostLlmDecomposer({
			model: fakeModel("active"),
			modelRegistry: stubRegistry,
			cwd: "/tmp",
			runSubprocess: run,
			availableRoles: [],
		});

		await decomposer.decompose({ task: "do" });

		expect(seen[0]?.context).toBeUndefined();
	});

	test("derives a stable subprocess id from the job id", async () => {
		const { run, seen } = captureRunOptions();
		const decomposer = new HostLlmDecomposer({
			model: fakeModel("active"),
			modelRegistry: stubRegistry,
			cwd: "/tmp",
			runSubprocess: run,
		});

		await decomposer.decompose({ task: "do", jobId: "legion-review-src" });

		expect(seen[0]?.id).toBe("legion-review-src-decomposer-0");
	});
});
