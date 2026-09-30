<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4">
	<h1 class="text-2xl font-semibold tracking-tight">Personal agent</h1>
	<p class="text-muted-foreground">
		No app yet. The clickable flow board lives at the prototype route.
	</p>
	<a class="font-medium text-brand underline" href={resolve('/proto')}>Open the flow board</a>
</main>
