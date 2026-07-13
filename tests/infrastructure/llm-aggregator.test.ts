import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

import type { AggregatorInput } from "../../src/domain/synthesis";
import { AGGREGATOR_SYSTEM_PROMPT } from "../../src/infrastructure/aggregator-prompts";
import { HostLlmAggregator } from "../../src/infrastructure/llm-aggregator";

function fakeModel(id: string): Model<Api> {
	return { provider: "test", id } as unknown as Model<Api>;
}

function input(): AggregatorInput {
	return {
		task: "Pick the sharpest next question",
		taskId: "task-1",
		experts: [],
		clusters: [],
		clusteringMethod: "embedding",
	};
}

const registry = {} as ModelRegistry;

describe("HostLlmAggregator", () => {
	// Regression test for a live-confirmed incident: the aggregator's own
	// model (captured once at session_start, unrelated to any expert's
	// model) failed to resolve from a background job, and there was no
	// retry of any kind — the aggregator threw immediately, relying
	// entirely on SynthesisService's own degrade-to-raw-answer fallback.
	// That fallback must stay as the last resort, but a plain transient
	// model failure should try other configured models first.
	test("uses the primary model when it succeeds, without touching fallbacks", async () => {
		const calls: string[] = [];
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fallback"],
			resolveModel: () => fakeModel("fallback"),
			complete: async (options) => {
				calls.push(options.model.id);
				return "primary answer";
			},
		});

		const result = await aggregator.synthesize(input());

		expect(result).toBe("primary answer");
		expect(calls).toEqual(["primary"]);
	});

	test("retries the next fallback model when the primary fails", async () => {
		const calls: string[] = [];
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fallback-1", "provider/fallback-2"],
			resolveModel: (selector) => fakeModel(selector.split("/")[1] ?? selector),
			complete: async (options) => {
				calls.push(options.model.id);
				if (options.model.id !== "fallback-2") {
					throw new Error("Model not found gpt-5.6-luna");
				}
				return "fallback answer";
			},
		});

		const result = await aggregator.synthesize(input());

		expect(result).toBe("fallback answer");
		expect(calls).toEqual(["primary", "fallback-1", "fallback-2"]);
	});

	test("skips a fallback selector that fails to resolve to a real model", async () => {
		const calls: string[] = [];
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/unresolvable", "provider/real"],
			resolveModel: (selector) =>
				selector === "provider/real" ? fakeModel("real") : undefined,
			complete: async (options) => {
				calls.push(options.model.id);
				if (options.model.id === "primary") throw new Error("unavailable");
				return "real answer";
			},
		});

		const result = await aggregator.synthesize(input());

		expect(result).toBe("real answer");
		expect(calls).toEqual(["primary", "real"]);
	});

	test("rethrows the last error when the primary and every fallback fail", async () => {
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fallback"],
			resolveModel: () => fakeModel("fallback"),
			complete: async (options) => {
				throw new Error(`${options.model.id} unavailable`);
			},
		});

		await expect(aggregator.synthesize(input())).rejects.toThrow(
			"fallback unavailable",
		);
	});

	test("rethrows the primary error when no fallbackModels are configured", async () => {
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			complete: async () => {
				throw new Error("Model not found gpt-5.6-luna");
			},
		});

		await expect(aggregator.synthesize(input())).rejects.toThrow(
			"Model not found gpt-5.6-luna",
		);
	});

	test("preserves the original error when primary fails and no fallbacks configured", async () => {
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			complete: async () => {
				throw new Error("original primary error");
			},
		});

		await expect(aggregator.synthesize(input())).rejects.toThrow(
			"original primary error",
		);
	});
	test("aborts while fallback request is still in flight", async () => {
		let started = false;
		let deferred: {
			resolve: (value: string) => void;
			reject: (error: Error) => void;
		} | null = null;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fb1"],
			resolveModel: () => fakeModel("fb1"),
			complete: async (options, _system, _prompt, signal) => {
				if (options.model.id === "primary") {
					throw new Error("primary failed");
				}
				started = true;
				const promise = new Promise<string>((resolve, reject) => {
					deferred = { resolve, reject };
				});
				if (signal?.aborted) {
					deferred = null;
					throw new Error("aborted");
				}
				signal?.addEventListener("abort", () => {
					if (deferred) {
						deferred.reject(new Error("aborted"));
						deferred = null;
					}
				});
				return promise;
			},
		});

		const controller = new AbortController();
		const promise = aggregator.synthesize(input(), controller.signal);
		await Promise.resolve(); // let the primary fail and fallback start
		controller.abort();

		await expect(promise).rejects.toThrow("aborted");
		expect(started).toBe(true); // fallback attempt was started
	});

	test("aborts after fallback settles late", async () => {
		let started = false;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fb1"],
			resolveModel: () => fakeModel("fb1"),
			complete: async (options, _system, _prompt, signal) => {
				if (options.model.id === "primary") {
					throw new Error("primary failed");
				}
				started = true;
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (signal?.aborted) throw new Error("aborted");
				return "fallback answer";
			},
		});

		const controller = new AbortController();
		const promise = aggregator.synthesize(input(), controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();

		await expect(promise).rejects.toThrow("aborted");
		expect(started).toBe(true); // fallback attempt was started
	});

	test("fallback model receives the same prompt and system prompt as primary", async () => {
		let receivedPrompt = "";
		let receivedSystemPrompt: string[] = [];
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/repo",
			fallbackModels: ["provider/fb1"],
			resolveModel: () => fakeModel("fb1"),
			complete: async (options, systemPrompt, prompt) => {
				if (options.model.id === "primary") {
					throw new Error("primary failed");
				}
				receivedPrompt = prompt;
				receivedSystemPrompt = systemPrompt;
				return "fallback answer";
			},
		});

		await aggregator.synthesize(input());

		expect(receivedPrompt).toContain("Pick the sharpest next question");
		expect(receivedSystemPrompt).toEqual(AGGREGATOR_SYSTEM_PROMPT);
	});
});

// Error classification regression tests
describe("HostLlmAggregator error classification", () => {
	test("stops immediately on 401 error from primary, no fallback attempted", async () => {
		const error = new Error("401 Unauthorized");
		let fallbackAttempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1", "fallback-2"],
			complete: async (opts) => {
				if (opts.model.id === "primary") throw error;
				fallbackAttempted = true;
				throw new Error("should not be called");
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallbackAttempted).toBe(false);
		expect(result).toBe(error);
	});

	test("stops immediately on 403 error from primary, no fallback attempted", async () => {
		const error = new Error("403 Forbidden");
		let fallbackAttempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1", "fallback-2"],
			complete: async (opts) => {
				if (opts.model.id === "primary") throw error;
				fallbackAttempted = true;
				throw new Error("should not be called");
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallbackAttempted).toBe(false);
		expect(result).toBe(error);
	});

	test("stops immediately on context-length-exceeded error from primary, no fallback attempted", async () => {
		const error = new Error("context length exceeded");
		let fallbackAttempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1", "fallback-2"],
			complete: async (opts) => {
				if (opts.model.id === "primary") throw error;
				fallbackAttempted = true;
				throw new Error("should not be called");
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallbackAttempted).toBe(false);
		expect(result).toBe(error);
	});

	test("stops immediately on maximum-context error from primary, no fallback attempted", async () => {
		const error = new Error("maximum context length exceeded");
		let fallbackAttempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1", "fallback-2"],
			complete: async (opts) => {
				if (opts.model.id === "primary") throw error;
				fallbackAttempted = true;
				throw new Error("should not be called");
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallbackAttempted).toBe(false);
		expect(result).toBe(error);
	});

	test("tries fallbacks on transient network error", async () => {
		const primaryError = new Error("ECONNREFUSED");
		const fallbackError = new Error("fallback failed");
		let fallbackAttempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1"],
			resolveModel: () => fakeModel("fallback-1"),
			complete: async (opts) => {
				if (opts.model.id === "primary") throw primaryError;
				fallbackAttempted = true;
				throw fallbackError;
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallbackAttempted).toBe(true);
		expect(result).toBe(fallbackError);
	});

	test("stops on fatal error from fallback and does not try remaining fallbacks", async () => {
		const primaryError = new Error("transient error");
		const fatalFallbackError = new Error("403 Forbidden");
		let fallback1Attempted = false;
		let fallback2Attempted = false;

		const registry = {} as ModelRegistry;
		const aggregator = new HostLlmAggregator({
			model: fakeModel("primary"),
			modelRegistry: registry,
			cwd: "/tmp",
			fallbackModels: ["fallback-1", "fallback-2"],
			resolveModel: (selector) => fakeModel(selector),
			complete: async (opts) => {
				if (opts.model.id === "primary") throw primaryError;
				if (opts.model.id === "fallback-1") {
					fallback1Attempted = true;
					throw fatalFallbackError;
				}
				fallback2Attempted = true;
				throw new Error("should not be called");
			},
		});

		const result = await aggregator.synthesize(input()).catch((e) => e);
		expect(fallback1Attempted).toBe(true);
		expect(fallback2Attempted).toBe(false);
		expect(result).toBe(fatalFallbackError);
	});
});
