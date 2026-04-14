<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, formatDate } from '$lib/api';

  interface User {
    id: string;
    name: string | null;
    email: string;
    role: 'admin' | 'user';
    status: 'active' | 'banned';
    created_at: string;
  }

  let users = $state<User[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let statusFilter = $state('all');

  async function loadUsers(): Promise<void> {
    loading = true;
    error = null;
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      users = await apiFetch<User[]>(`/api/users${params}`);
    } catch (e) {
      error = e instanceof Error ? e.message : '読み込みに失敗しました';
    } finally {
      loading = false;
    }
  }

  onMount(loadUsers);
</script>

<svelte:head>
  <title>ユーザー管理 — 0g0 Admin</title>
</svelte:head>

<div class="page-header" style="display:flex; align-items:center; justify-content:space-between;">
  <div>
    <h1 class="page-title">ユーザー管理</h1>
    <p class="page-subtitle">{users.length} 件</p>
  </div>
  <div class="form-group" style="flex-direction:row; align-items:center; gap:8px;">
    <label for="status-filter" style="white-space:nowrap;">状態:</label>
    <select id="status-filter" bind:value={statusFilter} onchange={loadUsers}>
      <option value="all">すべて</option>
      <option value="active">アクティブ</option>
      <option value="banned">BAN</option>
    </select>
  </div>
</div>

{#if loading}
  <div style="display:flex; justify-content:center; padding:3rem;">
    <div class="spinner"></div>
  </div>
{:else if error}
  <div class="alert alert-error">{error}</div>
{:else}
  <div class="card" style="padding:0; overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>名前</th>
          <th>メールアドレス</th>
          <th>ロール</th>
          <th>状態</th>
          <th>登録日</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user}
          <tr>
            <td>{user.name ?? '—'}</td>
            <td style="color:var(--color-muted); font-size:0.875rem;">{user.email}</td>
            <td>
              <span class="badge badge-{user.role}">{user.role === 'admin' ? '管理者' : 'ユーザー'}</span>
            </td>
            <td>
              <span class="badge badge-{user.status}">{user.status === 'active' ? 'アクティブ' : 'BAN'}</span>
            </td>
            <td style="color:var(--color-muted); font-size:0.875rem;">{formatDate(user.created_at)}</td>
            <td>
              <a href="/users/{user.id}" class="btn btn-ghost" style="padding:4px 10px; font-size:0.8rem;">詳細</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if users.length === 0}
      <div style="padding:2rem; text-align:center; color:var(--color-muted);">ユーザーが見つかりません</div>
    {/if}
  </div>
{/if}
