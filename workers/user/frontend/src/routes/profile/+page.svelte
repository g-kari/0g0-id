<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/api';
	import { showToast } from '$lib/toast.svelte';

	interface User {
		id: string;
		name: string;
		email: string;
		picture?: string;
		phone?: string;
		address?: string;
	}

	let user = $state<User | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let errorMsg = $state('');

	let nameInput = $state('');
	let pictureInput = $state('');
	let phoneInput = $state('');
	let addressInput = $state('');

	onMount(async () => {
		const res = await apiFetch<User>('/api/me');
		loading = false;
		if ('error' in res) {
			errorMsg = 'プロフィールの取得に失敗しました。再度ログインしてください。';
			return;
		}
		user = res.data;
		nameInput = user.name;
		pictureInput = user.picture ?? '';
		phoneInput = user.phone ?? '';
		addressInput = user.address ?? '';
	});

	async function save() {
		if (!nameInput.trim()) return;
		saving = true;
		const res = await apiFetch<User>('/api/me', {
			method: 'PATCH',
			body: JSON.stringify({
				name: nameInput.trim(),
				picture: pictureInput.trim() || null,
				phone: phoneInput.trim() || null,
				address: addressInput.trim() || null
			})
		});
		saving = false;
		if ('error' in res) {
			showToast('更新に失敗しました', 'error');
		} else {
			user = res.data;
			showToast('プロフィールを更新しました', 'success');
		}
	}

	async function logout() {
		await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
		window.location.href = '/';
	}

	const initials = $derived(user ? (user.name || '?').charAt(0).toUpperCase() : '');
</script>

<svelte:head>
	<title>0g0 ID - プロフィール</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="w-full max-w-sm">
		{#if loading}
			<div class="card flex items-center justify-center gap-2 py-8" style="color: var(--color-muted)">
				<span class="spinner"></span>
				<span>読み込み中...</span>
			</div>
		{:else if errorMsg}
			<div class="card">
				<p class="text-sm mb-4" style="color: var(--color-danger)">{errorMsg}</p>
				<a href="/" class="btn btn-ghost btn-full">ログインページへ</a>
			</div>
		{:else if user}
			<div class="card">
				<!-- プロフィールヘッダー -->
				<div class="flex items-center gap-4 mb-6">
					{#if user.picture}
						<img src={user.picture} alt="プロフィール画像" class="w-16 h-16 rounded-full object-cover flex-shrink-0" />
					{:else}
						<div class="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold flex-shrink-0"
							style="background: var(--color-text); color: var(--color-bg)">
							{initials}
						</div>
					{/if}
					<div class="flex-1 min-w-0">
						<p class="font-semibold text-lg truncate">{user.name}</p>
						<p class="text-sm truncate" style="color: var(--color-muted)">{user.email}</p>
					</div>
				</div>

				<hr class="mb-6" style="border-color: var(--color-border)" />

				<form onsubmit={(e) => { e.preventDefault(); save(); }} class="flex flex-col gap-4">
					<div class="form-group">
						<label for="name">表示名</label>
						<input id="name" type="text" bind:value={nameInput} required minlength="1" maxlength="100" />
					</div>
					<div class="form-group">
						<label for="picture">プロフィール画像URL</label>
						<input id="picture" type="url" bind:value={pictureInput} maxlength="500" placeholder="https://example.com/avatar.jpg" />
					</div>
					<div class="form-group">
						<label for="phone">電話番号</label>
						<input id="phone" type="tel" bind:value={phoneInput} maxlength="20" placeholder="090-1234-5678" />
					</div>
					<div class="form-group">
						<label for="address">住所</label>
						<input id="address" type="text" bind:value={addressInput} maxlength="200" placeholder="東京都渋谷区..." />
					</div>

					<div class="flex flex-col gap-2 mt-2">
						<button type="submit" class="btn btn-primary btn-full" disabled={saving}>
							{saving ? '保存中...' : '保存'}
						</button>
						<a href="/connections" class="btn btn-ghost btn-full">連携サービス管理</a>
						<a href="/sessions" class="btn btn-ghost btn-full">ログイン中のデバイス</a>
						<button type="button" class="btn btn-danger btn-full" onclick={logout}>ログアウト</button>
					</div>
				</form>
			</div>
		{/if}
	</div>
</div>
