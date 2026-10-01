export type LocationReply =
	| { status: 'shared'; latitude: number; longitude: number; accuracy: number; timestamp: number }
	| { status: 'denied' | 'unsupported' | 'timeout' | 'unavailable' | 'cancelled' };

/** Invoked only by the Share button. No watches, caching, persistence or browser error messages. */
export function currentLocation(
	signal: AbortSignal,
	geo = navigator.geolocation
): Promise<LocationReply> {
	if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
	if (!geo) return Promise.resolve({ status: 'unsupported' });
	if (!navigator.onLine) return Promise.resolve({ status: 'unavailable' });
	return new Promise((resolve) => {
		let finished = false;
		const done = (r: LocationReply) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', cancel);
			resolve(r);
		};
		const cancel = () => done({ status: 'cancelled' });
		// Some browsers do not count time spent in a permission prompt toward their timeout.
		const timer = setTimeout(() => done({ status: 'timeout' }), 20_000);
		signal.addEventListener('abort', cancel, { once: true });
		try {
			geo.getCurrentPosition(
				(p) =>
					done({
						status: 'shared',
						latitude: p.coords.latitude,
						longitude: p.coords.longitude,
						accuracy: p.coords.accuracy,
						timestamp: p.timestamp
					}),
				(e) => done({ status: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
				{ enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
			);
		} catch {
			done({ status: 'unavailable' });
		}
	});
}

export function locationOutcome(reply: LocationReply): string {
	return reply.status === 'shared'
		? 'Location shared for this question.'
		: `Location ${reply.status}. You can give the agent a city or area instead.`;
}
