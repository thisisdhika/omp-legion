import type {
	DispatchAuditData,
	DispatchRecord,
	ExpertResult,
	OrchestrationRepository,
} from "../domain/dispatch";

function cloneRecord(record: DispatchRecord): DispatchRecord {
	return {
		...record,
		attempts: record.attempts.map((attempt) => ({ ...attempt })),
		results: record.results?.map((result) => ({ ...result })),
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
	};
}

export class InMemoryOrchestrationRepository
	implements OrchestrationRepository
{
	readonly #records = new Map<string, DispatchRecord>();

	create(record: DispatchRecord): void {
		if (this.#records.has(record.id))
			throw new Error(`Orchestration ${record.id} already exists.`);
		this.#records.set(record.id, cloneRecord(record));
	}

	complete(
		id: string,
		results: readonly ExpertResult[],
		syntheses: DispatchRecord["syntheses"],
		governance: DispatchRecord["governance"],
		completedAt: number,
		resolutions?: DispatchRecord["resolutions"],
	): void {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Orchestration ${id} was not found.`);
		this.#records.set(
			id,
			cloneRecord({
				...record,
				state: "completed",
				completedAt,
				results,
				syntheses,
				governance,
				resolutions,
			}),
		);
	}

	fail(
		id: string,
		error: string,
		completedAt: number,
		audit?: DispatchAuditData,
	): void {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Orchestration ${id} was not found.`);
		this.#records.set(
			id,
			cloneRecord({
				...record,
				state: "failed",
				completedAt,
				error,
				...audit,
			}),
		);
	}

	get(id: string): DispatchRecord | undefined {
		const record = this.#records.get(id);
		return record ? cloneRecord(record) : undefined;
	}
}
