import { describe, expect, it } from 'bun:test';
import {
	parseOwnedDevicesResponse,
	parseUploadUrlResponse,
} from '../src/stk/response-shape';

describe('parseOwnedDevicesResponse', () => {
	it('maps a valid device list', () => {
		const parsed = parseOwnedDevicesResponse({
			ownedDevices: [
				{ deviceSerialNumber: 'AAA', deviceName: 'Kindle 1' },
				{ deviceSerialNumber: 'BBB', deviceName: 'Kindle 2' },
			],
		});
		expect(parsed).toEqual([
			{ serialNumber: 'AAA', deviceName: 'Kindle 1' },
			{ serialNumber: 'BBB', deviceName: 'Kindle 2' },
		]);
	});

	it('returns an empty list for an empty device array', () => {
		expect(parseOwnedDevicesResponse({ ownedDevices: [] })).toEqual([]);
	});

	it('rejects a missing or non-array ownedDevices field', () => {
		expect(() => parseOwnedDevicesResponse({})).toThrow('Invalid owned devices response');
		expect(() => parseOwnedDevicesResponse({ ownedDevices: 'x' })).toThrow(
			'Invalid owned devices response',
		);
		expect(() => parseOwnedDevicesResponse({ ownedDevices: 3 })).toThrow(
			'Invalid owned devices response',
		);
	});

	it('rejects non-object and malformed device entries', () => {
		const base = { ownedDevices: [{ deviceSerialNumber: 'AAA', deviceName: 'Kindle' }] };
		expect(() => parseOwnedDevicesResponse({ ownedDevices: [null] })).toThrow(
			'Invalid owned devices response',
		);
		expect(() => parseOwnedDevicesResponse({ ownedDevices: ['AAA'] })).toThrow(
			'Invalid owned devices response',
		);
		expect(() => parseOwnedDevicesResponse({ ownedDevices: [{}] })).toThrow(
			'Invalid owned devices response',
		);
		expect(
			() => parseOwnedDevicesResponse({
				ownedDevices: [{ deviceSerialNumber: '', deviceName: 'Kindle' }],
			}),
		).toThrow('Invalid owned devices response');
		expect(
			() => parseOwnedDevicesResponse({
				ownedDevices: [{ deviceSerialNumber: 'AAA', deviceName: '' }],
			}),
		).toThrow('Invalid owned devices response');
		expect(
			() => parseOwnedDevicesResponse({
				ownedDevices: [{ deviceSerialNumber: 123, deviceName: 'Kindle' }],
			}),
		).toThrow('Invalid owned devices response');
		expect(() => parseOwnedDevicesResponse(base.ownedDevices)).toThrow(
			'Invalid owned devices response',
		);
	});

	it('rejects a non-object top-level value', () => {
		expect(() => parseOwnedDevicesResponse(null)).toThrow('Invalid owned devices response');
		expect(() => parseOwnedDevicesResponse('x')).toThrow('Invalid owned devices response');
		expect(() => parseOwnedDevicesResponse([1])).toThrow('Invalid owned devices response');
	});
});

describe('parseUploadUrlResponse', () => {
	it('returns the upload URL and token for a valid response', () => {
		const parsed = parseUploadUrlResponse({
			uploadUrl: 'https://bucket.s3.amazonaws.com/x.epub?X-Amz-Signature=abc',
			stkToken: 'tok123',
		});
		expect(parsed).toEqual({
			uploadUrl: 'https://bucket.s3.amazonaws.com/x.epub?X-Amz-Signature=abc',
			stkToken: 'tok123',
		});
	});

	it('rejects missing or empty uploadUrl', () => {
		expect(() => parseUploadUrlResponse({ stkToken: 'tok' })).toThrow(
			'Invalid upload URL response',
		);
		expect(() => parseUploadUrlResponse({ uploadUrl: '', stkToken: 'tok' })).toThrow(
			'Invalid upload URL response',
		);
		expect(() => parseUploadUrlResponse({ uploadUrl: 5, stkToken: 'tok' })).toThrow(
			'Invalid upload URL response',
		);
	});

	it('rejects missing or empty stkToken', () => {
		expect(() => parseUploadUrlResponse({ uploadUrl: 'https://s3.amazonaws.com/x' })).toThrow(
			'Invalid upload URL response',
		);
		expect(
			() => parseUploadUrlResponse({ uploadUrl: 'https://s3.amazonaws.com/x', stkToken: '' }),
		).toThrow('Invalid upload URL response');
	});

	it('rejects non-object top-level values', () => {
		expect(() => parseUploadUrlResponse(null)).toThrow('Invalid upload URL response');
		expect(() => parseUploadUrlResponse([])).toThrow('Invalid upload URL response');
	});
});
