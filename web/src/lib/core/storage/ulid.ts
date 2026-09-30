const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48-bit millisecond time plus 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
	let time = '';
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let rand = '';
	for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] & 31];
	return time + rand;
}
