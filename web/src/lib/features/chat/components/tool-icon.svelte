<script lang="ts">
	import BookOpen from '@lucide/svelte/icons/book-open';
	import Search from '@lucide/svelte/icons/search';
	import Terminal from '@lucide/svelte/icons/terminal';
	import FilePen from '@lucide/svelte/icons/file-pen';
	import Globe from '@lucide/svelte/icons/globe';
	import Database from '@lucide/svelte/icons/database';
	import Users from '@lucide/svelte/icons/users';
	import Wrench from '@lucide/svelte/icons/wrench';
	import type { ToolKind } from '../tool-activity';
	let { kind }: { kind: ToolKind } = $props();
	const icons = {
		read: BookOpen,
		search: Search,
		bash: Terminal,
		edit: FilePen,
		browse: Globe,
		database: Database,
		agent: Users,
		other: Wrench
	};
	const Icon = $derived(icons[kind]);
</script>

<Icon class="size-4 shrink-0" aria-hidden="true" />
