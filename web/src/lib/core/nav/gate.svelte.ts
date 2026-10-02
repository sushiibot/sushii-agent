import { goto } from '$app/navigation';
import { features, type ClientFeature } from '$lib/core/features.svelte';

/** Fixture-only screens require a local preview override until their backend ships. */
export function previewGate(preview: ClientFeature): () => boolean {
	$effect(() => {
		if (!features.has(preview)) void goto('/chat', { replaceState: true });
	});
	return () => features.has(preview);
}
