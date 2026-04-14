<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/api';
  import { showToast } from '$lib/toast.svelte';

  interface User {
    id: string;
    name: string | null;
    email: string;
    picture: string | null;
    phone: string | null;
    address: string | null;
    role: 'admin' | 'user';
  }

  let user = $state<User | null>(null);
  let draft = $state({ name: '', picture: '', phone: '', address: '' });
  let loading = $state(true);
  let saving = $state(false);
  let logoutLoading = $state(false);

  const initials = $derived(
    user?.name
      ? user.name
          .split(' ')
          .map((w) => w[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)
      : user?.email?.[0]?.toUpperCase() ?? '?'
  );

  onMount(async () => {
    const res = await apiFetch<User>('/api/me');
    if ('error' in res) {
      showToast(res.error.message, 'error');
    } else {
      user = res;
      draft = {
        name: res.name ?? '',
        picture: res.picture ?? '',
        phone: res.phone ?? '',
        address: res.address ?? ''
      };
    }
    loading = false;
  });

  async function save(): Promise<void> {
    saving = true;
    const res = await apiFetch<User>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: draft.name || null,
        picture: draft.picture || null,
        phone: draft.phone || null,
        address: draft.address || null
      })
    });
    saving = false;
    if ('error' in res) {
      showToast(res.error.message, 'error');
    } else {
      user = res;
      draft = {
        name: res.name ?? '',
        picture: res.picture ?? '',
        phone: res.phone ?? '',
        address: res.address ?? ''
      };
      showToast('保存しました', 'success');
    }
  }

  async function logout(): Promise<void> {
    logoutLoading = true;
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/';
  }
</script>

<svelte:head>
  <title>プロフィール</title>
</svelte:head>

{#if loading}
  <div class="flex items-center justify-center min-h-screen">
    <div class="spinner"></div>
  </div>
{:else if user}
  <div class="min-h-screen p-4" style="background:var(--color-surface);">
    <div style="max-width:480px; margin:0 auto; display:flex; flex-direction:column; gap:1.5rem; padding:2rem 0;">

      <!-- Avatar + name -->
      <div class="card" style="text-align:center; display:flex; flex-direction:column; align-items:center; gap:1rem;">
        {#if user.picture}
          <img src={user.picture} alt="アバター" style="width:64px; height:64px; border-radius:50%; object-fit:cover;" />
        {:else}
          <div style="width:64px; height:64px; border-radius:50%; background:var(--color-accent); color:white; display:flex; align-items:center; justify-content:center; font-size:1.5rem; font-weight:700;">
            {initials}
          </div>
        {/if}
        <div>
          <div style="font-weight:600;">{user.name ?? '—'}</div>
          <div style="color:var(--color-muted); font-size:0.875rem;">{user.email}</div>
        </div>
      </div>

      <!-- Edit form -->
      <div class="card" style="display:flex; flex-direction:column; gap:1rem;">
        <h2 style="font-weight:600;">プロフィール編集</h2>
        <div class="form-group">
          <label for="name">名前</label>
          <input id="name" type="text" bind:value={draft.name} placeholder="山田 太郎" />
        </div>
        <div class="form-group">
          <label for="picture">プロフィール画像 URL</label>
          <input id="picture" type="url" bind:value={draft.picture} placeholder="https://..." />
        </div>
        <div class="form-group">
          <label for="phone">電話番号</label>
          <input id="phone" type="tel" bind:value={draft.phone} placeholder="090-0000-0000" />
        </div>
        <div class="form-group">
          <label for="address">住所</label>
          <input id="address" type="text" bind:value={draft.address} placeholder="東京都..." />
        </div>
        <button class="btn btn-primary" disabled={saving} onclick={save}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      <!-- Danger zone -->
      <div class="card" style="display:flex; flex-direction:column; gap:0.75rem;">
        <h2 style="font-weight:600;">アカウント</h2>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <a href="/sessions" class="btn btn-ghost">セッション管理</a>
          <a href="/connections" class="btn btn-ghost">連携サービス</a>
        </div>
        <button class="btn btn-danger" disabled={logoutLoading} onclick={logout}>
          {logoutLoading ? 'ログアウト中...' : 'ログアウト'}
        </button>
      </div>
    </div>
  </div>
{/if}
