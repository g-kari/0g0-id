<script lang="ts">
	import '../app.css';
	import { getToasts } from '$lib/toast.svelte';

	let { children } = $props();
</script>

{@render children()}

<!-- トースト通知 -->
<div class="toast-container">
	{#each getToasts() as toast (toast.id)}
		<div class="toast toast-{toast.type}">{toast.message}</div>
	{/each}
</div>

<style>
	.toast-container {
		position: fixed;
		bottom: 1.5rem;
		right: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		z-index: 1000;
		pointer-events: none;
	}
	.toast {
		padding: 0.75rem 1.25rem;
		border-radius: 8px;
		font-size: 0.875rem;
		font-weight: 500;
		box-shadow: 0 4px 12px rgba(72, 48, 48, 0.18);
		animation: toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		max-width: 320px;
		pointer-events: auto;
	}
	.toast-success { background: #2d5a34; color: #fff; }
	.toast-error { background: #483030; color: #fff; }
	@keyframes toast-in {
		from { opacity: 0; transform: translateX(0.75rem); }
		to { opacity: 1; transform: translateX(0); }
	}
</style>
