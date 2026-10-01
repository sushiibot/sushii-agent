<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SettingsScreen, settingsStore } from '$lib/features/settings';

	const settings = settingsStore();
	const goBack = backTo(resolve('/more'));

	onMount(() => settings.open());
</script>

<svelte:head><title>Settings · Agent</title></svelte:head>

<SettingsScreen
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
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
