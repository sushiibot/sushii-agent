// Dev only (`bun dev` with ?fake); +layout.ts imports it behind import.meta.env.DEV.
import { hub } from '$lib/core/realtime/hub.svelte';
import { configureChat } from '$lib/features/chat';
import { createFakeBackend } from '$lib/features/chat/fake';
import { configureHistory } from '$lib/features/history';
import { fixtureHistoryApi } from '$lib/features/history/fake';
import { configureHome } from '$lib/features/home';
import { fixtureHomeApi } from '$lib/features/home/fake';
import { configureRuns } from '$lib/features/runs';
import { fixtureRunsApi } from '$lib/features/runs/fake';
import { features } from '$lib/core/features.svelte';
import { WEB_FEATURES } from '$lib/core/realtime/events';

export function installFakes() {
	const fake = createFakeBackend();
	hub.useTransport(fake.transport);
	configureChat({ api: fake.api });
	configureHome({ api: fixtureHomeApi });
	configureRuns(fixtureRunsApi);
	configureHistory(fixtureHistoryApi);
	features.list = [...WEB_FEATURES];
	features.fresh = true;
}
