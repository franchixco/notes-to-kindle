import { describe, expect, it } from 'bun:test';
import { STK_USER_AGENT } from '../src/stk/user-agent';

describe('STK_USER_AGENT', () => {
	it('includes the transparent Agent/notes-to-kindle token', () => {
		expect(STK_USER_AGENT).toContain('Agent/notes-to-kindle');
	});

	it('retains a Mozilla compatibility prefix', () => {
		expect(STK_USER_AGENT.startsWith('Mozilla/')).toBe(true);
	});

	it('does not leak the previous plugin id/version token', () => {
		expect(STK_USER_AGENT).not.toContain('obsidian-kindle-stk');
		expect(STK_USER_AGENT).not.toContain('0.1.0');
	});

	it('does not leak the deprecated send-to-kindle identity', () => {
		expect(STK_USER_AGENT).not.toContain('send-to-kindle');
	});
});
