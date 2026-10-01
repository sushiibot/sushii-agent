import { afterEach, expect, test } from 'bun:test';
import { currentLocation } from './location';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'navigator', original);
	else Reflect.deleteProperty(globalThis, 'navigator');
});
function browser(geo: Partial<Geolocation> | undefined, online = true) {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { geolocation: geo, onLine: online }
	});
}
const signal = () => new AbortController().signal;
test('one high accuracy fix, explicit options and minimal data only', async () => {
	let calls = 0;
	browser({
		getCurrentPosition(success, _error, options) {
			calls++;
			expect(options).toEqual({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
			success({
				coords: { latitude: 1, longitude: 2, accuracy: 3, altitude: 99 },
				timestamp: 100
			} as GeolocationPosition);
		}
	});
	expect(await currentLocation(signal())).toEqual({
		status: 'shared',
		latitude: 1,
		longitude: 2,
		accuracy: 3,
		timestamp: 100
	});
	expect(calls).toBe(1);
});
test('denied, unavailable, timeout and exceptions are bounded statuses', async () => {
	for (const [code, status] of [
		[1, 'denied'],
		[2, 'unavailable'],
		[3, 'timeout']
	] as const) {
		browser({
			getCurrentPosition(_success, error) {
				error?.({ code, message: 'do not transmit this' } as GeolocationPositionError);
			}
		});
		expect(await currentLocation(signal())).toEqual({ status });
	}
	browser({
		getCurrentPosition() {
			throw new Error('browser failure');
		}
	});
	expect(await currentLocation(signal())).toEqual({ status: 'unavailable' });
});
test('unsupported and offline do not invoke a browser request', async () => {
	browser(undefined);
	expect(await currentLocation(signal())).toEqual({ status: 'unsupported' });
	browser(
		{
			getCurrentPosition() {
				throw new Error('must not call');
			}
		},
		false
	);
	expect(await currentLocation(signal())).toEqual({ status: 'unavailable' });
});
test('cancel ignores late success; no watch or background follow-up', async () => {
	let success!: PositionCallback;
	browser({
		getCurrentPosition(cb) {
			success = cb;
		}
	});
	const controller = new AbortController();
	const pending = currentLocation(controller.signal);
	controller.abort();
	success({
		coords: { latitude: 1, longitude: 2, accuracy: 3 },
		timestamp: 100
	} as GeolocationPosition);
	expect(await pending).toEqual({ status: 'cancelled' });
});
