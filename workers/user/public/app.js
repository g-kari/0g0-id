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

  var path = window.location.pathname;

  // エラーパラメータ表示（ログインページ）
  if (path === '/' || path === '/index.html') {
    var params = new URLSearchParams(window.location.search);
    var errorEl = document.getElementById('error-msg');
    if (params.get('error') && errorEl) {
      var messages = {
        missing_params: 'パラメータが不足しています',
        missing_session: 'セッションが見つかりません',
        state_mismatch: 'セキュリティエラーが発生しました',
        exchange_failed: '認証に失敗しました',
      };
      errorEl.textContent = messages[params.get('error')] || '認証エラーが発生しました';
      errorEl.style.display = 'block';
    }
    return;
  }

  // プロフィールページ
  if (path === '/profile.html') {
    var card = document.getElementById('profile-card');
    var loading = document.getElementById('loading');
    var avatar = document.getElementById('avatar');
    var nameEl = document.getElementById('profile-name');
    var emailEl = document.getElementById('profile-email');
    var nameInput = document.getElementById('name-input');
    var editForm = document.getElementById('edit-form');
    var saveBtn = editForm ? editForm.querySelector('button[type="submit"]') : null;
    var logoutBtn = document.getElementById('logout-btn');

    // プロフィール取得
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401) { window.location.href = '/'; return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) { window.location.href = '/'; return; }
        var user = data.data;
        if (avatar) {
          avatar.src = user.picture || '';
          avatar.style.display = user.picture ? 'block' : 'none';
        }
        if (nameEl) nameEl.textContent = user.name;
        if (emailEl) emailEl.textContent = user.email;
        if (nameInput) nameInput.value = user.name;
        if (loading) loading.style.display = 'none';
        if (card) card.style.display = 'block';
      })
      .catch(function () { window.location.href = '/'; });

    // プロフィール更新
    if (editForm) {
      editForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = nameInput ? nameInput.value.trim() : '';
        if (!name) return;

        // 二重送信防止
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.textContent = '保存中...';
        }

        fetch('/api/me', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) {
              showToast('更新に失敗しました', 'error');
            } else {
              if (nameEl) nameEl.textContent = data.data.name;
              if (nameInput) nameInput.value = data.data.name;
              showToast('プロフィールを更新しました', 'success');
            }
          })
          .catch(function () {
            showToast('通信エラーが発生しました', 'error');
          })
          .finally(function () {
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = '保存';
            }
          });
      });
    }

    // ログアウト
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .then(function () { window.location.href = '/'; })
          .catch(function () { window.location.href = '/'; });
      });
    }
  }
})();
