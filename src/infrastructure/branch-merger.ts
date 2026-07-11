import {
	cleanupTaskBranches,
	getRepoRoot,
	mergeTaskBranches,
} from "@oh-my-pi/pi-coding-agent/task/worktree";

import type {
	BranchMerger,
	WinningAttempt,
} from "../application/dispatch-service";

export interface HostBranchMergerOptions {
	readonly cwd: string;
}

/**
 * Wraps the host's own branch merge/cleanup primitives (the same ones
 * `task/isolation-runner.ts` uses) rather than reinventing cherry-pick,
 * conflict handling, or stash bookkeeping — see ADR 0002.
 */
export class HostBranchMerger implements BranchMerger {
	readonly #cwd: string;

	constructor(options: HostBranchMergerOptions) {
		this.#cwd = options.cwd;
	}

	async mergeWinners(winners: readonly WinningAttempt[]): Promise<void> {
		if (winners.length === 0) return;
		const repoRoot = await getRepoRoot(this.#cwd);
		const result = await mergeTaskBranches(
			repoRoot,
			winners.map((winner) => ({
				branchName: winner.branchName,
				taskId: winner.taskId,
				baseSha: winner.baseSha,
			})),
		);
		if (result.merged.length > 0) {
			await cleanupTaskBranches(repoRoot, result.merged);
		}
		if (result.failed.length > 0) {
			const conflict = result.conflict ? `: ${result.conflict}` : ".";
			throw new Error(
				`Legion could not merge ${result.failed.length} winning attempt branch(es) onto the repo${conflict} Unmerged branches remain for manual resolution.`,
			);
		}
	}

	async discardBranches(branchNames: readonly string[]): Promise<void> {
		if (branchNames.length === 0) return;
		const repoRoot = await getRepoRoot(this.#cwd);
		await cleanupTaskBranches(repoRoot, [...branchNames]);
	}
}
