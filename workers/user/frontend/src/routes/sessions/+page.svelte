<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, formatDatetime } from '$lib/api';
	import { showToast } from '$lib/toast.svelte';

	interface Session {
		id: string;
		service_name?: string;
		created_at: string;
		expires_at: string;
	}

	let sessions = $state<Session[]>([]);
	let loading = $state(true);
	let error = $state('');

	onMount(loadSessions);

	async function loadSessions() {
		loading = true;
		const res = await apiFetch<Session[]>('/api/me/sessions');
		loading = false;
		if ('error' in res) {
			error = 'セッション一覧の取得に失敗しました';
			return;
		}
		sessions = res.data;
	}

	async function revoke(id: string) {
		if (!confirm('このセッションを無効化しますか？')) return;
		const res = await apiFetch(`/api/me/sessions/${id}`, {
			method: 'DELETE',
			headers: { Origin: window.location.origin }
		});
		if ('error' in res) {
			showToast('無効化に失敗しました', 'error');
		} else {
			showToast('セッションを無効化しました', 'success');
			await loadSessions();
		}
	}

	async function revokeAll() {
		if (!confirm('すべてのセッションを無効化しますか？この操作後、ログアウトされます。')) return;
		const res = await apiFetch('/api/me/sessions', {
			method: 'DELETE',
			headers: { Origin: window.location.origin }
		});
		if ('error' in res) {
			showToast('無効化に失敗しました', 'error');
		} else {
			showToast('すべてのセッションを無効化しました', 'success');
			setTimeout(() => { window.location.href = '/'; }, 1200);
		}
	}
</script>

<svelte:head>
	<title>0g0 ID - ログイン中のデバイス</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="w-full" style="max-width: 480px">
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h1 class="text-2xl font-bold">ログイン中のデバイス</h1>
				<a href="/profile" class="btn btn-ghost btn-sm">← プロフィール</a>
			</div>
			<p class="text-sm mb-6" style="color: var(--color-muted)">
				現在アクティブなセッションの一覧です。身に覚えのないセッションは無効化してください。
			</p>

			{#if loading}
				<div class="flex items-center justify-center gap-2 py-8" style="color: var(--color-muted)">
					<span class="spinner"></span>
					<span>読み込み中...</span>
				</div>
			{:else if error}
				<p class="alert alert-error">{error}</p>
			{:else if sessions.length === 0}
				<p class="text-center py-8" style="color: var(--color-muted)">アクティブなセッションはありません</p>
			{:else}
				<div>
					{#each sessions as s (s.id)}
						<div class="flex items-center justify-between py-3.5 border-b last:border-b-0"
							style="border-color: var(--color-border)">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-1.5 font-semibold text-sm">
									{#if s.service_name}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>
										{s.service_name}
									{:else}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
										0g0 ID（IdP セッション）
									{/if}
								</div>
								<div class="text-xs mt-0.5" style="color: var(--color-muted)">
									作成: {formatDatetime(s.created_at)} ／ 有効期限: {formatDatetime(s.expires_at)}
								</div>
							</div>
							<button class="btn btn-danger btn-sm ml-3" onclick={() => revoke(s.id)}>
								無効化
							</button>
						</div>
					{/each}
				</div>

				<hr class="my-5" style="border-color: var(--color-border)" />
				<button class="btn btn-danger btn-full" onclick={revokeAll}>
					すべてのセッションを無効化
				</button>
			{/if}
		</div>
	</div>
</div>
