/**
 * Per-key sequential task queue.
 *
 * Port of openclaw's `createSequentialQueue`: tasks enqueued under the same
 * `key` run FIFO (serialized), while different keys run concurrently. Used to
 * serialize per-chat message handling so one chat's turns don't interleave,
 * while other chats proceed in parallel.
 *
 * Timeout-eviction (issues openclaw #64324 / #70133): if a task runs longer
 * than `taskTimeoutMs`, it is EVICTED from the blocking chain so later tasks
 * for the same key can proceed — but it is NOT aborted, it keeps running in
 * the background. This prevents a single hung agent turn from wedging a chat
 * forever, without cancelling work that may still complete.
 */

export interface SequentialQueueOptions {
	/** Max ms a task may block the chain before it is evicted. 0 disables. */
	taskTimeoutMs?: number;
	/** Called when a task is evicted for exceeding the timeout. */
	onTaskTimeout?: (key: string) => void;
}

export interface SequentialQueue {
	/** Enqueue `task` under `key`; resolves/rejects with the task's outcome. */
	enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
	/** Number of keys with in-flight or queued work (for diagnostics). */
	size(): number;
}

export function createSequentialQueue(options: SequentialQueueOptions = {}): SequentialQueue {
	const { taskTimeoutMs = 0, onTaskTimeout } = options;
	// The tail promise per key. Resolves when that key's chain is drained.
	const tails = new Map<string, Promise<void>>();

	function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
		const prev = tails.get(key) ?? Promise.resolve();

		// The caller's result is bound to this task specifically.
		let settle!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason: unknown) => void;
		const result = new Promise<T>((res, rej) => {
			settle = res;
			reject = rej;
		});

		// `barrier` is what the NEXT task waits on. It resolves either when this
		// task settles, or when the timeout evicts it — whichever comes first.
		const barrier = prev.then(
			() =>
				new Promise<void>((releaseChain) => {
					let released = false;
					const release = () => {
						if (released) return;
						released = true;
						releaseChain();
					};

					let timer: ReturnType<typeof setTimeout> | undefined;
					if (taskTimeoutMs > 0) {
						timer = setTimeout(() => {
							onTaskTimeout?.(key);
							release(); // evict from chain; task keeps running
						}, taskTimeoutMs);
					}

					// Run the task; wire its outcome to the caller's `result`.
					void (async () => {
						try {
							settle(await task());
						} catch (err) {
							reject(err);
						} finally {
							if (timer) clearTimeout(timer);
							release();
						}
					})();
				}),
		);

		// Store the barrier as the new tail; clean up when it fully drains.
		tails.set(key, barrier);
		void barrier.then(() => {
			if (tails.get(key) === barrier) tails.delete(key);
		});

		return result;
	}

	return { enqueue, size: () => tails.size };
}
