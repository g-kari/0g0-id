'use strict';

(function () {
  const path = window.location.pathname;

  // エラーパラメータ表示（ログインページ）
  if (path === '/' || path === '/index.html') {
    const params = new URLSearchParams(window.location.search);
    const errorEl = document.getElementById('error-msg');
    if (params.get('error') && errorEl) {
      const messages = {
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
    const card = document.getElementById('profile-card');
    const loading = document.getElementById('loading');
    const avatar = document.getElementById('avatar');
    const nameEl = document.getElementById('profile-name');
    const emailEl = document.getElementById('profile-email');
    const nameInput = document.getElementById('name-input');
    const editMsg = document.getElementById('edit-msg');
    const editForm = document.getElementById('edit-form');
    const logoutBtn = document.getElementById('logout-btn');

    function showMsg(msg, type) {
      editMsg.textContent = msg;
      editMsg.className = 'alert alert-' + type;
      editMsg.style.display = 'block';
    }

    // プロフィール取得
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/';
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          window.location.href = '/';
          return;
        }
        const user = data.data;
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
      .catch(function () {
        window.location.href = '/';
      });

    // プロフィール更新
    if (editForm) {
      editForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) return;

        fetch('/api/me', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) {
              showMsg('更新に失敗しました', 'error');
            } else {
              if (nameEl) nameEl.textContent = data.data.name;
              showMsg('プロフィールを更新しました', 'success');
            }
          })
          .catch(function () {
            showMsg('通信エラーが発生しました', 'error');
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
