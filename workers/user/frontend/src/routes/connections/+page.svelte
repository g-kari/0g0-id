<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, formatDate } from '$lib/api';
	import { showToast } from '$lib/toast.svelte';

	interface Connection {
		service_id: string;
		service_name: string;
		first_authorized_at: string;
	}

	let connections = $state<Connection[]>([]);
	let loading = $state(true);
	let error = $state('');

	onMount(loadConnections);

	async function loadConnections() {
		loading = true;
		const res = await apiFetch<Connection[]>('/api/connections');
		loading = false;
		if ('error' in res) {
			error = '連携サービスの取得に失敗しました';
			return;
		}
		connections = res.data;
	}

	async function disconnect(id: string, name: string) {
		if (!confirm(`「${name}」との連携を解除しますか？`)) return;
		const res = await apiFetch(`/api/connections/${id}`, {
			method: 'DELETE',
			headers: { Origin: window.location.origin }
		});
		if ('error' in res) {
			showToast('解除に失敗しました', 'error');
		} else {
			showToast('連携を解除しました', 'success');
			await loadConnections();
		}
	}
</script>

<svelte:head>
	<title>0g0 ID - 連携サービス</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="w-full" style="max-width: 480px">
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h1 class="text-2xl font-bold">連携サービス</h1>
				<a href="/profile" class="btn btn-ghost btn-sm">← プロフィール</a>
			</div>
			<p class="text-sm mb-6" style="color: var(--color-muted)">
				アクセスを許可しているサービスの一覧です。不要なサービスは連携を解除できます。
			</p>

			{#if loading}
				<div class="flex items-center justify-center gap-2 py-8" style="color: var(--color-muted)">
					<span class="spinner"></span>
					<span>読み込み中...</span>
				</div>
			{:else if error}
				<p class="alert alert-error">{error}</p>
			{:else if connections.length === 0}
				<p class="text-center py-8" style="color: var(--color-muted)">連携中のサービスはありません</p>
			{:else}
				<div>
					{#each connections as c (c.service_id)}
						<div class="flex items-center justify-between py-3.5 border-b last:border-b-0"
							style="border-color: var(--color-border)">
							<div class="flex-1 min-w-0">
								<div class="font-semibold text-sm truncate">{c.service_name}</div>
								<div class="text-xs mt-0.5" style="color: var(--color-muted)">
									連携日: {formatDate(c.first_authorized_at)}
								</div>
							</div>
							<button
								class="btn btn-danger btn-sm ml-3"
								onclick={() => disconnect(c.service_id, c.service_name)}>
								解除
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
