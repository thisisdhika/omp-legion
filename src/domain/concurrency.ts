/**
 * Bounds how many callers hold a slot at once. The host's own
 * `task.maxConcurrency` cap lives only inside `TaskTool` (never inside the
 * shared `runSubprocess` executor), so Legion — which calls that executor
 * directly (ADR 0002) — inherits no concurrency cap at all. This is Legion's
 * own, independent of task grouping: it bounds total concurrent expert
 * attempts across an entire dispatch, not per-task.
 */
export class Semaphore {
	readonly #capacity: number;
	#active = 0;
	#queue: Array<() => void> = [];

	constructor(capacity: number) {
		if (capacity < 1) throw new Error("Semaphore capacity must be at least 1.");
		this.#capacity = capacity;
	}

	acquire(): Promise<void> {
		if (this.#active < this.#capacity) {
			this.#active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.#queue.push(() => {
				this.#active++;
				resolve();
			});
		});
	}

	release(): void {
		this.#active--;
		this.#queue.shift()?.();
	}
}
