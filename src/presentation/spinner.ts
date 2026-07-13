/**
 * Lightweight spinner frames and progress-text builder for the Legion TUI.
 *
 * Avoids pulling in omp-halo's heavier spinner-loop infrastructure — this is
 * just a frame array and a one-shot text formatter that the tool's `execute`
 * method calls on each poll tick.
 */

export const SPINNER_FRAMES: readonly string[] = [
	"⡀",
	"⣀",
	"⣄",
	"⣤",
	"⣦",
	"⣶",
	"⣷",
	"⣿",
	"⣿",
	"⣷",
	"⣶",
	"⣦",
	"⣤",
	"⣄",
	"⣀",
	"⡀",
] as const;

export const PROGRESS_FRAMES: readonly string[] = [
	"⠁",
	"⠂",
	"⠄",
	"⡀",
	"⢀",
	"⠠",
	"⠐",
	"⠈",
] as const;

export function spinnerChar(frameIndex: number): string {
	const glyph = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
	return glyph ?? "?";
}

/**
 * Progress text for the "Dispatching…" / "Synthesizing…" phase shown while
 * the job is running. The phase name is derived from the job's label or the
 * last reported progress text.
 */
export function buildProgressText(
	phase: string,
	frame: number,
	attemptsRunning?: number,
): string {
	const spin = spinnerChar(frame);
	const running =
		attemptsRunning !== undefined && attemptsRunning > 0
			? ` (${attemptsRunning} running)`
			: "";
	return `${spin} ${phase}${running}…`;
}

export interface SpinnerLoop {
	readonly frames: readonly string[];
	start(onFrame: (frame: number) => void): void;
	stop(): void;
}

export function useSpinnerLoop(
	intervalMs = 80,
	initialFrame = 0,
	frames: readonly string[] = SPINNER_FRAMES,
): SpinnerLoop {
	let frame = initialFrame % frames.length;
	let timer: ReturnType<typeof setInterval> | undefined;
	const safeFrame = (onFrame: (frame: number) => void, value: number): void => {
		try {
			onFrame(value);
		} catch (error) {
			console.warn(
				"Legion spinner frame callback failed; stopping spinner.",
				error,
			);
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		}
	};
	return {
		frames,
		start(onFrame) {
			if (timer !== undefined) return;
			safeFrame(onFrame, frame);
			if (timer !== undefined) return;
			timer = setInterval(() => {
				frame = (frame + 1) % frames.length;
				safeFrame(onFrame, frame);
			}, intervalMs);
		},
		stop() {
			if (timer === undefined) return;
			clearInterval(timer);
			timer = undefined;
		},
	};
}
