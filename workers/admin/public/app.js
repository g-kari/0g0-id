'use strict';

(function () {
  // トースト通知
  function showToast(message, type) {
    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  }

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

    // リダイレクトURI管理
    const uriModal = document.getElementById('uri-modal');
    const uriModalTitle = document.getElementById('uri-modal-title');
    const uriModalServiceName = document.getElementById('uri-modal-service-name');
    const uriList = document.getElementById('uri-list');
    const uriAddForm = document.getElementById('uri-add-form');
    const uriInput = document.getElementById('uri-input');
    const uriCloseBtn = document.getElementById('uri-close-btn');
    var currentServiceId = null;

    function loadUris(serviceId) {
      if (!uriList) return;
      uriList.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">読み込み中...</p>';
      fetch('/api/services/' + serviceId + '/redirect-uris', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { uriList.innerHTML = '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>'; return; }
          var uris = data.data || [];
          if (uris.length === 0) {
            uriList.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">URIが登録されていません</p>';
            return;
          }
          uriList.innerHTML = uris.map(function (u) {
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);">' +
              '<span class="mono" style="font-size:0.8125rem;word-break:break-all;flex:1;">' + escHtml(u.uri) + '</span>' +
              '<button class="btn btn-danger btn-sm" style="margin-left:0.5rem;flex-shrink:0;" data-uri-id="' + escHtml(u.id) + '">削除</button>' +
              '</div>';
          }).join('');
          uriList.querySelectorAll('[data-uri-id]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              if (!confirm('このURIを削除しますか？')) return;
              fetch('/api/services/' + currentServiceId + '/redirect-uris/' + btn.dataset.uriId, {
                method: 'DELETE', credentials: 'same-origin',
              }).then(function (r) {
                if (r.ok || r.status === 204) {
                  showToast('URIを削除しました', 'success');
                  loadUris(currentServiceId);
                } else {
                  showToast('削除に失敗しました', 'error');
                }
              });
            });
          });
        })
        .catch(function () { uriList.innerHTML = '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>'; });
    }

    if (uriCloseBtn && uriModal) {
      uriCloseBtn.addEventListener('click', function () { uriModal.hidden = true; currentServiceId = null; });
    }

    if (uriAddForm) {
      uriAddForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentServiceId || !uriInput) return;
        var uri = uriInput.value.trim();
        if (!uri) return;
        fetch('/api/services/' + currentServiceId + '/redirect-uris', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: uri }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              showToast(data.error.code === 'CONFLICT' ? 'このURIは既に登録されています' : 'URIの追加に失敗しました', 'error');
            } else {
              uriInput.value = '';
              showToast('URIを追加しました', 'success');
              loadUris(currentServiceId);
            }
          })
          .catch(function () { showToast('通信エラーが発生しました', 'error'); });
      });
    }

    function loadServices() {
      fetch('/api/services', { credentials: 'same-origin' })
        .then(function (r) {
          if (r.status === 401) { window.location.href = '/'; return null; }
          return r.json();
        })
        .then(function (data) {
          if (!data) return;
          if (data.error) { showMsg(msgEl, 'サービスの取得に失敗しました', 'error'); showToast('サービスの取得に失敗しました', 'error'); return; }
          const rows = data.data.map(function (s) {
            return '<tr>' +
              '<td>' + escHtml(s.name) + '</td>' +
              '<td class="mono">' + escHtml(s.client_id) + '</td>' +
              '<td>' + formatDate(s.created_at) + '</td>' +
              '<td style="white-space:nowrap;">' +
                '<button class="btn btn-sm" style="background:var(--accent);color:#fff;margin-right:0.25rem;" data-uri-service-id="' + escHtml(s.id) + '" data-uri-service-name="' + escHtml(s.name) + '">URI管理</button>' +
                '<button class="btn btn-danger btn-sm" data-id="' + escHtml(s.id) + '">削除</button>' +
              '</td>' +
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
                    showToast('サービスを削除しました', 'success');
                    loadServices();
                  } else {
                    showToast('削除に失敗しました', 'error');
                  }
                });
              });
            });

            // URI管理ボタン
            tbody.querySelectorAll('[data-uri-service-id]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                currentServiceId = btn.dataset.uriServiceId;
                if (uriModalServiceName) uriModalServiceName.textContent = 'サービス: ' + btn.dataset.uriServiceName;
                if (uriInput) uriInput.value = '';
                if (uriModal) uriModal.hidden = false;
                loadUris(currentServiceId);
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
            if (data.error) { showToast('作成に失敗しました', 'error'); return; }
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
          .catch(function () { showToast('通信エラーが発生しました', 'error'); });
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
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--error);">' + escHtml(msg) + '</td></tr>';
      showToast(msg, 'error');
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
