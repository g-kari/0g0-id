<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';

  const { children } = $props();

  const navLinks = [
    { href: '/dashboard', label: 'ダッシュボード', icon: '📊' },
    { href: '/users', label: 'ユーザー管理', icon: '👥' },
    { href: '/services', label: 'サービス管理', icon: '🔧' }
  ];

  const isAdminPage = $derived(
    $page.url.pathname !== '/' && $page.url.pathname !== ''
  );
</script>

{#if isAdminPage}
  <div class="admin-layout">
    <aside class="sidebar">
      <div class="sidebar-logo">🔐 0g0 Admin</div>
      <nav class="sidebar-nav">
        {#each navLinks as link}
          <a
            href={link.href}
            class="sidebar-link {$page.url.pathname.startsWith(link.href) ? 'active' : ''}"
          >
            <span>{link.icon}</span>
            <span>{link.label}</span>
          </a>
        {/each}
      </nav>
      <div class="sidebar-footer">
        <form method="post" action="/auth/logout">
          <button type="submit" class="sidebar-link" style="width:100%; background:none; border:none; cursor:pointer; text-align:left;">
            <span>🚪</span>
            <span>ログアウト</span>
          </button>
        </form>
      </div>
    </aside>
    <main class="main-content">
      {@render children()}
    </main>
  </div>
{:else}
  {@render children()}
{/if}
