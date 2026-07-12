import { LEGION_ORCHESTRATION_ENTRY_TYPE } from "../domain/constants";
import type {
	DispatchAuditData,
	DispatchRecord,
	ExpertResult,
	OrchestrationRepository,
} from "../domain/dispatch";
import { InMemoryOrchestrationRepository } from "./in-memory-orchestration-repository";
import { cloneDispatchRecord, isDispatchRecord } from "./orchestration-record";

export interface HostSessionJournal {
	getEntries(): readonly unknown[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

interface CustomEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function asCustomEntry(value: unknown): CustomEntry | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return value as CustomEntry;
}

/**
 * Persists Legion's audit snapshots in the host session journal. Custom entries
 * are host-owned durable records, excluded from model context, and restored by
 * SessionManager when the process reopens the session.
 */
export class HostOrchestrationRepository implements OrchestrationRepository {
	readonly #journal: HostSessionJournal;
	readonly #records = new Map<string, DispatchRecord>();

	constructor(journal: HostSessionJournal) {
		this.#journal = journal;
		for (const entry of journal.getEntries()) {
			const custom = asCustomEntry(entry);
			if (
				custom?.type !== "custom" ||
				custom.customType !== LEGION_ORCHESTRATION_ENTRY_TYPE ||
				!isDispatchRecord(custom.data)
			)
				continue;
			this.#records.set(custom.data.id, cloneDispatchRecord(custom.data));
		}
	}

	create(record: DispatchRecord): void {
		if (this.#records.has(record.id))
			throw new Error(`Orchestration ${record.id} already exists.`);
		this.#persist(record);
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
		this.#persist({
			...record,
			state: "completed",
			completedAt,
			results,
			syntheses,
			governance,
			resolutions,
			decomposerAttempts,
		});
	}

	fail(
		id: string,
		error: string,
		completedAt: number,
		audit?: DispatchAuditData,
	): void {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Orchestration ${id} was not found.`);
		this.#persist({
			...record,
			state: "failed",
			completedAt,
			error,
			...audit,
		});
	}

	get(id: string): DispatchRecord | undefined {
		const record = this.#records.get(id);
		return record ? cloneDispatchRecord(record) : undefined;
	}

	#persist(record: DispatchRecord): void {
		const snapshot = cloneDispatchRecord(record);
		this.#journal.appendCustomEntry(LEGION_ORCHESTRATION_ENTRY_TYPE, snapshot);
		this.#records.set(snapshot.id, snapshot);
	}
}

function isHostSessionJournal(value: unknown): value is HostSessionJournal {
	if (value === null || typeof value !== "object") return false;
	return (
		"getEntries" in value &&
		typeof value.getEntries === "function" &&
		"appendCustomEntry" in value &&
		typeof value.appendCustomEntry === "function"
	);
}

export function createHostOrchestrationRepository(
	journal: unknown,
): OrchestrationRepository {
	if (!isHostSessionJournal(journal))
		return new InMemoryOrchestrationRepository();
	return new HostOrchestrationRepository(journal);
}
