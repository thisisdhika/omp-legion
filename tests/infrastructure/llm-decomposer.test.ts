import { describe, expect, test } from "bun:test";

import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

import type { DecomposerPolicy } from "../../src/domain/config";
import type { DecomposerAuditEvent } from "../../src/domain/decomposition";
import type { HostLlmOptions } from "../../src/infrastructure/host-llm";
import { HostLlmDecomposer } from "../../src/infrastructure/llm-decomposer";

type Behavior = "ok" | "fail" | "empty";

const SUCCESS_JSON = '{"tasks":[{"id":"t1","role":"coder","assignment":"x"}]}';

function fakeModel(id: string): Model<Api> {
	return { provider: "prov", id } as unknown as Model<Api>;
}

const stubRegistry = {
	find: (_provider: string, id: string) => (id ? fakeModel(id) : undefined),
	resolver: () => () => "key",
} as unknown as ModelRegistry;

type CompleteFn = (
	options: HostLlmOptions,
	systemPrompt: string[],
	prompt: string,
	signal?: AbortSignal,
) => Promise<string>;

function makeComplete(behaviors: Record<string, Behavior>) {
	let inFlight = 0;
	let maxInFlight = 0;
	const calls: string[] = [];
	const complete: CompleteFn = async (options, _system, _prompt, signal) => {
		if (signal?.aborted) throw new Error("aborted by signal");
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		inFlight -= 1;
		const id = options.model.id;
		calls.push(id);
		const behavior = behaviors[id] ?? "ok";
		if (behavior === "fail") throw new Error(`provider error for ${id}`);
		if (behavior === "empty") return '{"tasks":[]}';
		return SUCCESS_JSON;
	};
	return {
		complete,
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
	const { complete, calls, maxInFlight } = makeComplete(opts.behaviors);
	const auditEvents: DecomposerAuditEvent[] = [];
	const decomposer = new HostLlmDecomposer({
		model: fakeModel(opts.activeId ?? "active"),
		modelRegistry: stubRegistry,
		cwd: "/tmp",
		policy: opts.policy,
		resolveModel: opts.resolveModel ?? ((selector) => fakeModel(selector)),
		budget: opts.budget,
		audit: (event) => auditEvents.push(event),
		complete,
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
			behaviors: { activesession: "ok" },
		});
		const tasks = await decomposer.decompose({ task: "do" });
		expect(tasks[0]?.id).toBe("t1");
		expect(calls()).toEqual(["activesession"]);
		expect(auditEvents[0]).toMatchObject({
			selector: "prov/activesession",
			status: "success",
		});
	});
});
