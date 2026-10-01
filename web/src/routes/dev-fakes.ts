// Dev only (`bun dev` with ?fake); +layout.ts imports it behind import.meta.env.DEV.
import { ALL_FEATURES, features } from '$lib/core/features.svelte';
import { WEB_FEATURES } from '$lib/core/realtime/events';
import { createHub, hub } from '$lib/core/realtime/hub.svelte';
import { memoryKeyValue, type Draft, type OutboxEntry } from '$lib/core/storage/outbox';
import { configureBriefing } from '$lib/features/briefing';
import { createFixtureBriefingApi } from '$lib/features/briefing/fake';
import { configureBrowser } from '$lib/features/browser';
import { createFixtureBrowserApi } from '$lib/features/browser/fake';
import { configureChat, configureModels, createFixtureModelsApi } from '$lib/features/chat';
import { createFakeBackend } from '$lib/features/chat/fake';
import { configureConnectors } from '$lib/features/connectors';
import { createFixtureConnectorsApi } from '$lib/features/connectors/fake';
import { configureHistory } from '$lib/features/history';
import { fixtureHistoryApi } from '$lib/features/history/fake';
import { configureHome } from '$lib/features/home';
import { fixtureHomeApi } from '$lib/features/home/fake';
import { configureMemory } from '$lib/features/memory';
import { createFixtureMemoryApi } from '$lib/features/memory/fake';
import { configureRuns } from '$lib/features/runs';
import { fixtureRunsApi } from '$lib/features/runs/fake';
import { configureSchedules } from '$lib/features/schedules';
import { createFixtureSchedulesApi } from '$lib/features/schedules/fake';
import { configureSkills } from '$lib/features/skills';
import { createFixtureSkillsApi } from '$lib/features/skills/fake';
import { configureThreads } from '$lib/features/threads';
import { createFixtureThreadsApi } from '$lib/features/threads/fake';

export function installFakes() {
	const fake = createFakeBackend();
	hub.useTransport(fake.transport);
	configureChat({ api: fake.api });
	configureModels(createFixtureModelsApi());
	configureHome({ api: fixtureHomeApi });
	configureRuns(fixtureRunsApi);
	configureHistory(fixtureHistoryApi);
	configureMemory(createFixtureMemoryApi());
	configureSkills(createFixtureSkillsApi());
	configureSchedules(createFixtureSchedulesApi());
	configureBrowser(createFixtureBrowserApi());
	configureBriefing(createFixtureBriefingApi());
	configureConnectors(createFixtureConnectorsApi());
	// Each thread answers from its own scripted bot, seeded with its history.
	configureThreads({
		api: createFixtureThreadsApi(),
		chat: (detail) => {
			const thread = createFakeBackend({
				history: detail.history,
				reply: 'Noted. I kept this in the thread, and saved anything worth remembering.'
			});
			return {
				hub: createHub({ transport: thread.transport, carries: `thread:${detail.summary.id}` }),
				api: thread.api,
				outbox: memoryKeyValue<OutboxEntry>((e) => e.clientId),
				drafts: memoryKeyValue<Draft>((d) => d.id)
			};
		}
	});
	features.list = [...WEB_FEATURES];
	features.fresh = true;
	// For this page view only, so a later visit without ?fake shows what production shows.
	features.override = new Set(ALL_FEATURES);
}
