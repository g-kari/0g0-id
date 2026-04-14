<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, formatDate } from '$lib/api';

  interface Service {
    id: string;
    name: string;
    client_id: string;
    created_at: string;
  }

  interface NewServiceResult {
    id: string;
    name: string;
    client_id: string;
    client_secret: string;
  }

  let services = $state<Service[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showAddModal = $state(false);
  let newServiceName = $state('');
  let newServiceResult = $state<NewServiceResult | null>(null);
  let submitting = $state(false);

  onMount(async () => {
    try {
      services = await apiFetch<Service[]>('/api/services');
    } catch (e) {
      error = e instanceof Error ? e.message : '読み込みに失敗しました';
    } finally {
      loading = false;
    }
  });

  async function addService(): Promise<void> {
    if (!newServiceName.trim()) return;
    submitting = true;
    try {
      const result = await apiFetch<NewServiceResult>('/api/services', {
        method: 'POST',
        body: JSON.stringify({ name: newServiceName.trim() })
      });
      newServiceResult = result;
      services = [...services, { id: result.id, name: result.name, client_id: result.client_id, created_at: new Date().toISOString() }];
    } catch (e) {
      error = e instanceof Error ? e.message : '作成に失敗しました';
    } finally {
      submitting = false;
    }
  }

  async function deleteService(id: string, name: string): Promise<void> {
    if (!confirm(`「${name}」を削除しますか？`)) return;
    try {
      await apiFetch(`/api/services/${id}`, { method: 'DELETE' });
      services = services.filter((s) => s.id !== id);
    } catch (e) {
      error = e instanceof Error ? e.message : '削除に失敗しました';
    }
  }

  function closeAdd(): void {
    showAddModal = false;
    newServiceName = '';
    newServiceResult = null;
  }
</script>

<svelte:head>
  <title>サービス管理 — 0g0 Admin</title>
</svelte:head>

<div class="page-header" style="display:flex; align-items:center; justify-content:space-between;">
  <div>
    <h1 class="page-title">サービス管理</h1>
    <p class="page-subtitle">{services.length} 件</p>
  </div>
  <button class="btn btn-primary" onclick={() => (showAddModal = true)}>+ 追加</button>
</div>

{#if error}
  <div class="alert alert-error" style="margin-bottom:1rem;">{error}</div>
{/if}

{#if loading}
  <div style="display:flex; justify-content:center; padding:3rem;">
    <div class="spinner"></div>
  </div>
{:else}
  <div class="card" style="padding:0; overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>サービス名</th>
          <th>Client ID</th>
          <th>登録日</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {#each services as service}
          <tr>
            <td style="font-weight:500;">{service.name}</td>
            <td><code style="font-size:0.8rem; background:var(--color-surface); padding:2px 6px; border-radius:4px;">{service.client_id}</code></td>
            <td style="color:var(--color-muted); font-size:0.875rem;">{formatDate(service.created_at)}</td>
            <td style="display:flex; gap:6px;">
              <a href="/services/{service.id}" class="btn btn-ghost" style="padding:4px 10px; font-size:0.8rem;">詳細</a>
              <button class="btn btn-danger" style="padding:4px 10px; font-size:0.8rem;" onclick={() => deleteService(service.id, service.name)}>削除</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if services.length === 0}
      <div style="padding:2rem; text-align:center; color:var(--color-muted);">サービスが登録されていません</div>
    {/if}
  </div>
{/if}

<!-- Add Modal -->
{#if showAddModal}
  <div class="modal-backdrop" onclick={closeAdd}>
    <div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2 class="modal-title">{newServiceResult ? '作成完了' : '新規サービス追加'}</h2>
        <button class="btn btn-ghost" style="padding:4px 10px;" aria-label="閉じる" onclick={closeAdd}>✕</button>
      </div>

      {#if newServiceResult}
        <div class="alert alert-success">サービスを作成しました。シークレットは一度しか表示されません。</div>
        <div class="form-group">
          <label for="result-client-id">Client ID</label>
          <input id="result-client-id" type="text" readonly value={newServiceResult.client_id} />
        </div>
        <div class="form-group">
          <label for="result-client-secret">Client Secret（コピーして保存してください）</label>
          <input id="result-client-secret" type="text" readonly value={newServiceResult.client_secret} />
        </div>
        <button class="btn btn-primary" onclick={closeAdd}>閉じる</button>
      {:else}
        <div class="form-group">
          <label for="service-name">サービス名</label>
          <input id="service-name" type="text" bind:value={newServiceName} placeholder="例: My App" />
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn btn-ghost" onclick={closeAdd}>キャンセル</button>
          <button class="btn btn-primary" disabled={submitting || !newServiceName.trim()} onclick={addService}>
            {submitting ? '作成中...' : '作成'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
