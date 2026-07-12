import type {
	DispatchAuditData,
	DispatchRecord,
	ExpertResult,
	OrchestrationRepository,
} from "../domain/dispatch";
import { cloneDispatchRecord } from "./orchestration-record";

export class InMemoryOrchestrationRepository
	implements OrchestrationRepository
{
	readonly #records = new Map<string, DispatchRecord>();

	create(record: DispatchRecord): void {
		if (this.#records.has(record.id))
			throw new Error(`Orchestration ${record.id} already exists.`);
		this.#records.set(record.id, cloneDispatchRecord(record));
	}

	complete(
		id: string,
		results: readonly ExpertResult[],
		syntheses: DispatchRecord["syntheses"],
		governance: DispatchRecord["governance"],
		completedAt: number,
		resolutions?: DispatchRecord["resolutions"],
		decomposerAttempts?: DispatchRecord["decomposerAttempts"],
	): void {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Orchestration ${id} was not found.`);
		this.#records.set(
			id,
			cloneDispatchRecord({
				...record,
				state: "completed",
				completedAt,
				results,
				syntheses,
				governance,
				resolutions,
				decomposerAttempts,
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
			cloneDispatchRecord({
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
		return record ? cloneDispatchRecord(record) : undefined;
	}
}
