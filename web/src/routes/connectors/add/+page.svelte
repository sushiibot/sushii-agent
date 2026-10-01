<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { AddServerScreen, connectorsStore } from '$lib/features/connectors';

	const connectors = connectorsStore();
	connectors.resetAdd();
	const goBack = backTo(resolve('/connectors'));
	let copied = $state(false);

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}

	async function finish() {
		const id = await connectors.finish();
		// The finished flow leaves history, so back from the new server lands on the list.
		if (id) await goto(resolve('/connectors/[id]', { id }), { replaceState: true });
	}
</script>

<svelte:head><title>Add a server · Agent</title></svelte:head>

<AddServerScreen
	add={connectors.add}
	back={{ href: resolve('/connectors'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	{copied}
	onurl={(v) => (connectors.add.url = v)}
	onredirect={(v) => (connectors.add.redirect = v)}
	onbegin={() => void connectors.begin()}
	onsignedin={() => connectors.signedIn()}
	onfinish={() => void finish()}
	onstepback={() => connectors.stepBack()}
	oncopy={(t) => void copy(t)}
/>
