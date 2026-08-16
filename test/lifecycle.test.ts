import { describe, expect, it } from 'bun:test';
import { LatestAsyncRunner, OperationTracker } from '../src/lifecycle';

describe('OperationTracker', () => {
	it('returns a monotonic generation per begin', () => {
		const tracker = new OperationTracker();
		const first = tracker.begin();
		const second = tracker.begin();
		expect(second).toBeGreaterThan(first);
		expect(first).not.toBe(second);
	});

	it('tracks in-progress state', () => {
		const tracker = new OperationTracker();
		expect(tracker.inProgress).toBe(false);
		const generation = tracker.begin();
		expect(tracker.inProgress).toBe(true);
		expect(tracker.isCurrent(generation)).toBe(true);
		tracker.finish(generation);
		expect(tracker.inProgress).toBe(false);
		expect(tracker.isCurrent(generation)).toBe(false);
	});

	it('stale finish cannot clear a newer operation', () => {
		const tracker = new OperationTracker();
		const first = tracker.begin();
		const second = tracker.begin();
		expect(tracker.isCurrent(first)).toBe(false);
		expect(tracker.isCurrent(second)).toBe(true);
		tracker.finish(first);
		expect(tracker.inProgress).toBe(true);
		expect(tracker.isCurrent(second)).toBe(true);
		tracker.finish(second);
		expect(tracker.inProgress).toBe(false);
	});

	it('cancel invalidates the operation immediately', () => {
		const tracker = new OperationTracker();
		const generation = tracker.begin();
		expect(tracker.inProgress).toBe(true);
		tracker.cancel();
		expect(tracker.inProgress).toBe(false);
		expect(tracker.isCurrent(generation)).toBe(false);
	});

	it('cancel then stale finish must not resurrect a newer operation', () => {
		const tracker = new OperationTracker();
		const first = tracker.begin();
		tracker.cancel();
		const second = tracker.begin();
		tracker.finish(first);
		expect(tracker.inProgress).toBe(true);
		expect(tracker.isCurrent(second)).toBe(true);
		tracker.finish(second);
		expect(tracker.inProgress).toBe(false);
	});
});

describe('LatestAsyncRunner', () => {
	it('allows only one in-flight load at a time', () => {
		const runner = new LatestAsyncRunner();
		const first = runner.begin();
		expect(first).not.toBeNull();
		expect(runner.begin()).toBeNull();
		first?.finish();
		expect(runner.begin()).not.toBeNull();
	});

	it('stale finish cannot clear a newer load', () => {
		const runner = new LatestAsyncRunner();
		const first = runner.begin();
		expect(first).not.toBeNull();
		runner.invalidate();
		const second = runner.begin();
		expect(second).not.toBeNull();
		expect(first?.isCurrent()).toBe(false);
		first?.finish();
		expect(second?.isCurrent()).toBe(true);
		expect(runner.begin()).toBeNull();
		second?.finish();
		expect(runner.begin()).not.toBeNull();
	});

	it('an invalidated load cannot publish its result', () => {
		const runner = new LatestAsyncRunner();
		const op = runner.begin();
		expect(op).not.toBeNull();
		runner.invalidate();
		expect(op?.isCurrent()).toBe(false);
	});

	it('invalidate leaves a completed cache untouched', () => {
		const runner = new LatestAsyncRunner();
		const op = runner.begin();
		expect(op).not.toBeNull();
		op?.finish();
		runner.invalidate();
		expect(runner.begin()).not.toBeNull();
	});
});
