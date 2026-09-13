/**
 * Loader — memoized dynamic import of the overlay graph + prewarm timer.
 *
 * The overlay module is only imported when a foreground session first has
 * visible tasks; the prewarm evaluates it in the background 2s after startup
 * so the first real update doesn't pay the dynamic-import latency. A rejected
 * promise is dropped from the memo so the next update retries.
 */

export const PREWARM_DELAY_MS = 2000;

type OverlayModule = typeof import("./overlay/widget.ts");
export type OverlayImporter = () => Promise<OverlayModule>;

export function makeOverlayLoader(importOverlay: OverlayImporter = () => import("./overlay/widget.ts")): OverlayImporter {
	let memo: Promise<OverlayModule> | undefined;

	return async (): Promise<OverlayModule> => {
		memo ??= importOverlay();
		const current = memo;
		try {
			return await current;
		} catch (error) {
			// Clear only OUR rejected promise: a late catch from a concurrent
			// awaiter must never clobber a fresh retry another caller installed.
			if (memo === current) memo = undefined;
			throw error;
		}
	};
}

/** Fire-and-forget prewarm; unref so it never holds an embedder open. */
export function prewarmOverlay(load: OverlayImporter): void {
	const timer = setTimeout(() => void load().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}
