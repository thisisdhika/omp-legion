import { fileURLToPath } from "node:url";

import { DEFAULT_BENCHMARK_TIMEOUT_MS } from "../src/domain/constants";

const BENCHMARK_TASKS = [
	{
		id: "parser-guard",
		task: `Review this TypeScript parser and propose the smallest safe patch. It must reject malformed JSON with a useful error, preserve the inferred result type, and never silently return an empty object. Do not edit files; return the patch and a short rationale.

function parseConfig(input: string): Record<string, unknown> {
		try {
			return JSON.parse(input) as Record<string, unknown>;
		} catch {
			return {};
		}
	}`,
	},
	{
		id: "cancel-race",
		task: `Find the race in this async job helper and propose a deterministic fix. Cancellation must prevent completion callbacks after cancellation, while a task that already completed may still publish its result. Do not edit files; return the patch and a focused test.

async function run(runTask: () => Promise<string>, onDone: (value: string) => void, signal: AbortSignal) {
	const value = await runTask();
	if (signal.aborted) return;
	onDone(value);
}`,
	},
	{
		id: "fallback-contract",
		task: "Design a small test matrix for a provider chain that tries a configured registry model, then a local embedding service, then a degraded lexical fallback. The test must prove ordering, malformed-vector rejection, cancellation propagation, and that human-readable degradation is surfaced. Do not edit files; return concrete test cases and expected observations.",
	},
] as const;

const timeoutMs = Number.parseInt(
	process.env.LEGION_BENCH_TIMEOUT_MS ?? String(DEFAULT_BENCHMARK_TIMEOUT_MS),
	10,
);
const model = process.env.LEGION_BENCH_MODEL?.trim();
const ompBinary = process.env.LEGION_BENCH_OMP_BIN?.trim() || "omp";
const extensionPath = fileURLToPath(
	new URL("../src/index.ts", import.meta.url),
);

async function runOmp(prompt: string, withLegion: boolean): Promise<string> {
	const args = model ? ["--model", model] : [];
	if (withLegion) args.push("--extension", extensionPath);
	else args.push("--no-extensions");
	args.push("--print", prompt);

	const processHandle = Bun.spawn([ompBinary, ...args], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		processHandle.kill();
	}, timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			processHandle.exited,
			new Response(processHandle.stdout).text(),
			new Response(processHandle.stderr).text(),
		]);
		if (timedOut) throw new Error(`OMP timed out after ${timeoutMs}ms.`);
		if (exitCode !== 0)
			throw new Error(`OMP exited with ${exitCode}: ${stderr.trim()}`);
		return stdout.trim();
	} finally {
		clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	console.log(
		"Legion benchmark — live model comparison (no fabricated results)",
	);
	console.log(`Model: ${model || "host-selected model"}`);
	console.log(`Cases: ${BENCHMARK_TASKS.length}`);
	console.log("");

	for (const benchmark of BENCHMARK_TASKS) {
		const ensemblePrompt = [
			"You are running one Legion benchmark case.",
			"Do not edit files.",
			"Call legion_dispatch exactly once with this complete task and omit the tasks array so Legion can decompose it.",
			"Use the host job tool to poll the returned job id until it completes.",
			"Return only the final ensemble answer, including any useful patch or tests.",
			"",
			benchmark.task,
		].join("\n");
		const baselinePrompt = [
			"You are running one single-model benchmark baseline.",
			"Do not edit files. Solve the task directly and return only the final answer, including any useful patch or tests.",
			"",
			benchmark.task,
		].join("\n");

		console.log(`## ${benchmark.id}`);
		console.log("### Ensemble (legion_dispatch)");
		console.log(await runOmp(ensemblePrompt, true));
		console.log("");
		console.log("### Single-model baseline");
		console.log(await runOmp(baselinePrompt, false));
		console.log("");
	}
}

await main();
