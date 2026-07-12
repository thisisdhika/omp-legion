import type { DispatchRecord, ExpertResult } from "../domain/dispatch";

export function cloneDispatchRecord(record: DispatchRecord): DispatchRecord {
	return {
		...record,
		attempts: record.attempts.map((attempt) => ({ ...attempt })),
		results: record.results?.map((result: ExpertResult) => ({ ...result })),
		syntheses: record.syntheses?.map((synthesis) => ({
			...synthesis,
			clusters: synthesis.clusters.map((cluster) => ({
				...cluster,
				attemptIds: [...cluster.attemptIds],
			})),
		})),
		governance: record.governance?.map((decision) => ({
			...decision,
			reasons: [...decision.reasons],
			metrics: { ...decision.metrics },
			thresholds: { ...decision.thresholds },
		})),
		resolutions: record.resolutions?.map((resolution) => ({
			...resolution,
		})),
		decomposerAttempts: record.decomposerAttempts?.map((attempt) => ({
			...attempt,
		})),
	};
}

export function isDispatchRecord(value: unknown): value is DispatchRecord {
	if (value === null || typeof value !== "object") return false;
	const record = value as Partial<DispatchRecord>;
	return (
		typeof record.id === "string" &&
		typeof record.task === "string" &&
		(record.state === "running" ||
			record.state === "completed" ||
			record.state === "failed") &&
		typeof record.createdAt === "number" &&
		Array.isArray(record.attempts)
	);
}
