import { expect, test } from '@playwright/test';
import { BACKOFF_CAP_MS, defaultBackoff, fetchSse } from '../src/lib/chat/transport';

function sse(frames: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			for (const f of frames) c.enqueue(new TextEncoder().encode(f));
			c.close();
		}
	});
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const hello = (headSeq: number) =>
	`event: hello\ndata: ${JSON.stringify({ headSeq, workspace: 'online', openTurns: [] })}\n\n`;

/** Runs the transport until it has made `n` requests, then stops it. */
async function drive(n: number, respond: (i: number) => Response) {
	const urls: string[] = [];
	const attempts: number[] = [];
	const states: string[] = [];
	let stop!: () => void;
	await new Promise<void>((resolve) => {
		const t = fetchSse({
			url: '/s',
			backoff: (a) => {
				attempts.push(a);
				return 0;
			},
			fetch: (async (input: string) => {
				urls.push(input);
				if (urls.length >= n) queueMicrotask(resolve);
				return respond(urls.length - 1);
			}) as typeof fetch
		});
		stop = t.connect(
			null,
			() => {},
			(s) => states.push(s)
		);
	});
	stop();
	return { urls, attempts, states };
}

test('a stream that says hello and dies keeps backing off instead of resetting', async () => {
	const { attempts } = await drive(6, () => sse([hello(3)]));
	expect(attempts.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
});

test('the default backoff has jitter and never exceeds its cap', () => {
	const samples = Array.from({ length: 200 }, (_, i) => defaultBackoff(i % 12));
	expect(Math.max(...samples)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
	expect(new Set(samples.map((s) => Math.round(s))).size).toBeGreaterThan(10);
	expect(defaultBackoff(0)).toBeLessThanOrEqual(1000);
});

test('a resume keeps its cursor even when hello reports a later head', async () => {
	const { urls } = await drive(3, (i) =>
		i === 0
			? sse([hello(7), `event: proactive\nid: 8\ndata: {"key":"p","text":"x","files":[]}\n\n`])
			: sse([hello(12)])
	);
	expect(urls).toEqual(['/s', '/s?after=8', '/s?after=8']);
});
