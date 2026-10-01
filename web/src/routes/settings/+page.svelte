<script lang="ts">
	import { onMount } from 'svelte';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SettingsScreen, settingsStore } from '$lib/features/settings';

	const settings = settingsStore();

	onMount(() => settings.open());
</script>

<svelte:head><title>Settings · sushii</title></svelte:head>

<SettingsScreen
	me={settings.me}
	push={settings.push}
	pushBusy={settings.pushBusy}
	pushError={settings.pushError}
	pushSyncFailed={pwa.pushSync === 'failed'}
	testBusy={settings.testBusy}
	testResult={settings.testResult}
	theme={settings.theme}
	version={__APP_VERSION__}
	standalone={pwa.standalone}
	canInstall={pwa.canInstall}
	installFailed={settings.installFailed}
	swError={pwa.swError}
	online={pwa.online}
	updateReady={!!pwa.waiting}
	onretryme={() => void settings.me.refetch()}
	ontogglepush={() => void settings.togglePush()}
	ontest={() => void settings.sendTest()}
	onchoosetheme={(t) => settings.chooseTheme(t)}
	oninstall={() => void settings.install()}
	onreload={() => pwa.applyUpdate()}
/>
