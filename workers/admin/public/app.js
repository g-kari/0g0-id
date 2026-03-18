'use strict';

(function () {
  const path = window.location.pathname;

  // ログインページ
  if (path === '/' || path === '/index.html') {
    const params = new URLSearchParams(window.location.search);
    const errorEl = document.getElementById('error-msg');
    if (params.get('error') && errorEl) {
      const messages = {
        missing_params: 'パラメータが不足しています',
        missing_session: 'セッションが見つかりません',
        state_mismatch: 'セキュリティエラーが発生しました',
        exchange_failed: '認証に失敗しました',
        not_admin: '管理者アカウントではありません',
      };
      errorEl.textContent = messages[params.get('error')] || '認証エラーが発生しました';
      errorEl.style.display = 'block';
    }
    return;
  }

  // ログアウトボタン（共通）
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { window.location.href = '/'; })
        .catch(function () { window.location.href = '/'; });
    });
  }

  function showMsg(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'alert alert-' + type;
    el.style.display = 'block';
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('ja-JP');
  }

  // サービス管理ページ
  if (path === '/services.html') {
    const tbody = document.getElementById('services-body');
    const msgEl = document.getElementById('msg');
    const addModal = document.getElementById('add-modal');
    const secretModal = document.getElementById('secret-modal');
    const addForm = document.getElementById('add-form');
    const addBtn = document.getElementById('add-service-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const closeSecretBtn = document.getElementById('close-secret-btn');

    function loadServices() {
      fetch('/api/services', { credentials: 'same-origin' })
        .then(function (r) {
          if (r.status === 401) { window.location.href = '/'; return null; }
          return r.json();
        })
        .then(function (data) {
          if (!data) return;
          if (data.error) { showMsg(msgEl, 'サービスの取得に失敗しました', 'error'); return; }
          const rows = data.data.map(function (s) {
            return '<tr>' +
              '<td>' + escHtml(s.name) + '</td>' +
              '<td class="mono">' + escHtml(s.client_id) + '</td>' +
              '<td>' + formatDate(s.created_at) + '</td>' +
              '<td><button class="btn btn-danger btn-sm" data-id="' + escHtml(s.id) + '">削除</button></td>' +
              '</tr>';
          }).join('');
          if (tbody) tbody.innerHTML = rows || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">サービスなし</td></tr>';

          // 削除ボタン
          if (tbody) {
            tbody.querySelectorAll('[data-id]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                if (!confirm('このサービスを削除しますか？')) return;
                fetch('/api/services/' + btn.dataset.id, {
                  method: 'DELETE', credentials: 'same-origin',
                }).then(function (r) {
                  if (r.ok || r.status === 204) {
                    showMsg(msgEl, 'サービスを削除しました', 'success');
                    loadServices();
                  } else {
                    showMsg(msgEl, '削除に失敗しました', 'error');
                  }
                });
              });
            });
          }
        })
        .catch(function () { showMsg(msgEl, '通信エラーが発生しました', 'error'); });
    }

    loadServices();

    if (addBtn && addModal) {
      addBtn.addEventListener('click', function () { addModal.hidden = false; });
    }
    if (cancelBtn && addModal) {
      cancelBtn.addEventListener('click', function () { addModal.hidden = true; });
    }

    if (addForm) {
      addForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('service-name').value.trim();
        if (!name) return;

        fetch('/api/services', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) { showMsg(msgEl, '作成に失敗しました', 'error'); return; }
            if (addModal) addModal.hidden = true;
            addForm.reset();
            // シークレット表示
            const cidBox = document.getElementById('client-id-box');
            const csBox = document.getElementById('client-secret-box');
            if (cidBox) cidBox.textContent = data.data.client_id;
            if (csBox) csBox.textContent = data.data.client_secret;
            if (secretModal) secretModal.hidden = false;
            loadServices();
          })
          .catch(function () { showMsg(msgEl, '通信エラーが発生しました', 'error'); });
      });
    }

    if (closeSecretBtn && secretModal) {
      closeSecretBtn.addEventListener('click', function () { secretModal.hidden = true; });
    }
  }

  // ユーザー管理ページ
  if (path === '/users.html') {
    const tbody = document.getElementById('users-body');

    function showUsersError(msg) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-danger);">' + escHtml(msg) + '</td></tr>';
    }

    fetch('/api/users', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/'; return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) { showUsersError('ユーザーの取得に失敗しました'); return; }
        if (!data.data) { showUsersError('データの形式が不正です'); return; }
        const rows = data.data.map(function (u) {
          const badge = u.role === 'admin'
            ? '<span class="badge badge-admin">admin</span>'
            : '<span class="badge badge-user">user</span>';
          return '<tr>' +
            '<td>' + escHtml(u.name) + '</td>' +
            '<td>' + escHtml(u.email) + '</td>' +
            '<td>' + badge + '</td>' +
            '<td>' + formatDate(u.created_at) + '</td>' +
            '</tr>';
        }).join('');
        if (tbody) tbody.innerHTML = rows || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">ユーザーなし</td></tr>';
      })
      .catch(function () { showUsersError('通信エラーが発生しました'); });
  }
})();
