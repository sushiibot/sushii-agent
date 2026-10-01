import type { MeResponse } from '$lib/core/realtime/events';
import { request } from './http';

export type Me = MeResponse;
export type PushKey = { publicKey: string };
export type Ok = { ok: true };
export type PushTestResult = { sent: number; pruned: number };

export const api = {
	me: () => request<Me>('GET', '/me'),
	pushKey: () => request<PushKey>('GET', '/push/key'),
	subscribe: (subscription: PushSubscriptionJSON) =>
		request<Ok>('POST', '/push/subscribe', subscription),
	unsubscribe: (endpoint: string) => request<Ok>('DELETE', '/push/subscribe', { endpoint }),
	testPush: () => request<PushTestResult>('POST', '/push/test')
};
