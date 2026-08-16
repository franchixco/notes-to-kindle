/**
 * Dependency-free async lifecycle primitives shared by the plugin entry point
 * and the settings tab. A stale completion must never publish its result nor
 * clear the in-flight marker of a newer operation.
 */

/**
 * Tracks one OAuth/registration operation with a monotonic generation token.
 * Every asynchronous step must confirm `isCurrent(generation)` before acting
 * (storing credentials, mutating settings, showing notices); `cancel()` bumps
 * the generation so all in-flight steps go stale at once; `finish()` is a
 * no-op for a superseded operation, so a slow final step cannot clear a newer
 * operation's flag.
 */
export class OperationTracker {
	private generation = 0;
	private active = false;

	get inProgress(): boolean {
		return this.active;
	}

	begin(): number {
		this.generation += 1;
		this.active = true;
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation && this.active;
	}

	finish(generation: number): void {
		if (generation === this.generation) {
			this.active = false;
		}
	}

	cancel(): void {
		this.generation += 1;
		this.active = false;
	}
}

/**
 * Coordinates "latest wins" async loads that share one in-flight slot.
 * `begin()` returns null while another load is active; otherwise a handle
 * whose `isCurrent()` stays true only while this load is the active one and
 * whose `finish()` releases the slot. A stale `finish()` never clears a newer
 * load; `invalidate()` releases the slot without touching completed cache.
 */
export class LatestAsyncRunner {
	private token: object | null = null;

	begin(): { finish: () => void; isCurrent: () => boolean } | null {
		if (this.token !== null) return null;
		const token: object = {};
		this.token = token;
		return {
			isCurrent: () => this.token === token,
			finish: () => {
				if (this.token === token) this.token = null;
			},
		};
	}

	invalidate(): void {
		this.token = null;
	}
}
