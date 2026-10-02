<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { AddServerScreen, connectorsStore } from '$lib/features/connectors';

	const connectors = connectorsStore();
	$effect(() => {
		const url = page.url.searchParams.get('url') ?? undefined;
		untrack(() => connectors.openAdd(url));
	});
	onDestroy(() => connectors.leaveAdd());
	const goBack = backTo(resolve('/connectors'));
	let copied = $state(false);
	let copyError = $state<string | null>(null);

	async function copy(text: string) {
		copyError = null;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
			copyError = 'Couldn’t copy the sign-in link. Select the link and copy it manually.';
		}
	}

	async function begin() {
		const id = await connectors.begin();
		if (id) await goto(resolve('/connectors/[id]', { id }), { replaceState: true });
	}

	async function finish() {
		const id = await connectors.finish();
		// The finished flow leaves history, so back from the new server lands on the list.
		if (id) await goto(resolve('/connectors/[id]', { id }), { replaceState: true });
	}
</script>

<svelte:head><title>Add a server · sushii</title></svelte:head>

<AddServerScreen
	add={connectors.add}
	back={{ href: resolve('/connectors'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	{copied}
	{copyError}
	restored={connectors.addRestored}
	onstartover={() => connectors.resetAdd()}
	ontoken={(v) => (connectors.add.token = v)}
	onurl={(v) => {
		connectors.add.url = v;
		if (connectors.add.errorField === 'url') {
			connectors.add.error = null;
			connectors.add.errorField = undefined;
		}
	}}
	onredirect={(v) => (connectors.add.redirect = v)}
	onbegin={() => void begin()}
	onsignedin={() => connectors.signedIn()}
	onfinish={() => void finish()}
	onstepback={() => connectors.stepBack()}
	oncopy={(t) => void copy(t)}
/>
