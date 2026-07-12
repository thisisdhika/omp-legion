import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoRoot } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { worktree as gitWorktree } from "@oh-my-pi/pi-coding-agent/utils/git";

import type { Verifier, VerifyRequest } from "../application/dispatch-service";

export interface HostVerifierOptions {
	readonly cwd: string;
	readonly command: string;
}

function checkoutDirFor(branchName: string): string {
	const safeName = branchName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return join(tmpdir(), `legion-verify-${safeName}`);
}

/**
 * Independently re-runs the project's own verify command against one
 * attempt's isolated branch, checked out into a throwaway worktree — the
 * same worktree-add/remove primitives `task/worktree.ts` uses internally
 * for its own temp-checkout needs (ADR 0002: don't reinvent the host).
 * Running the actual verify command is generic subprocess execution, not a
 * host concern, so that part uses Bun directly.
 */
export class HostVerifier implements Verifier {
	readonly #cwd: string;
	readonly #command: string;

	constructor(options: HostVerifierOptions) {
		this.#cwd = options.cwd;
		this.#command = options.command;
	}

	async verify(request: VerifyRequest, signal?: AbortSignal): Promise<boolean> {
		const repoRoot = await getRepoRoot(this.#cwd);
		const checkoutDir = checkoutDirFor(request.branchName);
		try {
			await gitWorktree.add(repoRoot, checkoutDir, request.branchName, {
				signal,
			});
		} catch {
			// Couldn't even materialize the branch — treat as unverifiable, not
			// a crash; the text-based clustering path still has this attempt.
			return false;
		}
		try {
			const proc = Bun.spawn(["sh", "-c", this.#command], {
				cwd: checkoutDir,
				stdout: "ignore",
				stderr: "ignore",
				signal,
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		} finally {
			await gitWorktree.tryRemove(repoRoot, checkoutDir, { force: true });
			await rm(checkoutDir, { recursive: true, force: true });
		}
	}
}
