import { describe, expect, test } from "bun:test";
import { copyFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	currentDispatchContext,
	runAsDispatchedAgent,
	runWithDispatchContext,
} from "../../src/infrastructure/agent-execution-context";

describe("agent-execution-context", () => {
	test("runAsDispatchedAgent exposes an expert context for legion-* agents", async () => {
		await runAsDispatchedAgent("legion-coder", async () => {
			expect(currentDispatchContext()?.senderKind).toBe("expert");
			expect(currentDispatchContext()?.agentName).toBe("legion-coder");
		});
	});

	test("runAsDispatchedAgent exposes a host context for non-legion agents", async () => {
		await runAsDispatchedAgent("task", async () => {
			expect(currentDispatchContext()?.senderKind).toBe("host");
		});
	});

	test("no context outside any dispatch wrapper", () => {
		expect(currentDispatchContext()).toBeUndefined();
	});

	test("concurrent attempts stay isolated from each other", async () => {
		const seenA: Array<string | undefined> = [];
		const seenB: Array<string | undefined> = [];

		await Promise.all([
			runAsDispatchedAgent("legion-coder", async () => {
				seenA.push(currentDispatchContext()?.agentName);
				await new Promise((r) => setTimeout(r, 5));
				seenA.push(currentDispatchContext()?.agentName);
			}),
			runAsDispatchedAgent("legion-reviewer", async () => {
				seenB.push(currentDispatchContext()?.agentName);
				await new Promise((r) => setTimeout(r, 1));
				seenB.push(currentDispatchContext()?.agentName);
			}),
		]);

		expect(seenA).toEqual(["legion-coder", "legion-coder"]);
		expect(seenB).toEqual(["legion-reviewer", "legion-reviewer"]);
	});

	// Regression test for a live-confirmed bug: the host re-binds each
	// extension against its own ExtensionAPI inside a dispatched subagent
	// (re-importing the extension's source), which can hand this module a
	// second, freshly-evaluated instance in the same process. A plain
	// module-scoped `AsyncLocalStorage` would be a distinct object in that
	// second instance, so its `getStore()` would never see the parent's
	// `run()` context — every guard would silently see `undefined` for a real
	// expert. Confirmed live: git-commit-guard's fail-open-on-undefined
	// posture let a legion-coder expert's `git commit` through uncontested.
	test("a second, freshly re-evaluated copy of this module still sees the live context", async () => {
		// Bun's import cache keys by resolved path, and (unlike Node's file://
		// URL loader) does not treat a query-string suffix as a distinct
		// module — so the only reliable way to force a genuinely separate
		// module instance is a genuinely separate file path. The copy must
		// live alongside the original so its relative imports (`../domain/...`)
		// still resolve.
		const originalPath = resolve(
			import.meta.dir,
			"../../src/infrastructure/agent-execution-context.ts",
		);
		const copyPath = join(
			dirname(originalPath),
			"agent-execution-context.dup-test.ts",
		);
		copyFileSync(originalPath, copyPath);
		try {
			const freshModule = (await import(
				pathToFileURL(copyPath).href
			)) as typeof import("../../src/infrastructure/agent-execution-context");

			// Sanity check: this really is a distinct module instance, not the
			// cached one — otherwise this test would pass even without the fix.
			expect(freshModule.currentDispatchContext).not.toBe(
				currentDispatchContext,
			);

			await runAsDispatchedAgent("legion-coder", async () => {
				expect(freshModule.currentDispatchContext()?.senderKind).toBe("expert");
				expect(freshModule.currentDispatchContext()?.agentName).toBe(
					"legion-coder",
				);
			});
		} finally {
			unlinkSync(copyPath);
		}
	});

	test("runWithDispatchContext sets an explicit context", async () => {
		await runWithDispatchContext(
			{
				senderKind: "expert",
				agentName: "legion-reviewer",
				parentRoute: "legion-dispatch",
				allowedDestination: "legion-dispatch",
			},
			async () => {
				expect(currentDispatchContext()).toEqual({
					senderKind: "expert",
					agentName: "legion-reviewer",
					parentRoute: "legion-dispatch",
					allowedDestination: "legion-dispatch",
				});
			},
		);
	});
});
