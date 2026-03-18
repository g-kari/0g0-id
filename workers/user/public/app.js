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

  // プログレスバー
  var _progressBar = null;
  var _progressTimer = null;
  var _progressResetTimer = null;
  var _progressCount = 0;

  function getProgressBar() {
    if (!_progressBar) {
      _progressBar = document.createElement('div');
      _progressBar.id = 'progress-bar';
      document.body.insertBefore(_progressBar, document.body.firstChild);
    }
    return _progressBar;
  }

  function showProgress() {
    _progressCount++;
    var bar = getProgressBar();
    clearTimeout(_progressTimer);
    clearTimeout(_progressResetTimer);
    bar.style.transition = 'none';
    bar.style.width = '0%';
    bar.style.opacity = '1';
    setTimeout(function () {
      bar.style.transition = 'width 0.8s ease';
      bar.style.width = '75%';
    }, 16);
  }

  function hideProgress() {
    _progressCount = Math.max(0, _progressCount - 1);
    if (_progressCount > 0) return;
    var bar = getProgressBar();
    bar.style.transition = 'width 0.15s ease';
    bar.style.width = '100%';
    _progressTimer = setTimeout(function () {
      bar.style.transition = 'opacity 0.3s ease';
      bar.style.opacity = '0';
      _progressResetTimer = setTimeout(function () { bar.style.width = '0%'; }, 300);
    }, 150);
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
    var phoneInput = document.getElementById('phone-input');
    var addressInput = document.getElementById('address-input');
    var editForm = document.getElementById('edit-form');
    var saveBtn = editForm ? editForm.querySelector('button[type="submit"]') : null;
    var logoutBtn = document.getElementById('logout-btn');

    function showProfileError(msg) {
      hideProgress();
      if (loading) {
        loading.innerHTML = '<div style="text-align:center;padding:1rem;">' +
          '<p style="color:var(--error,#e53e3e);margin-bottom:1rem;">' + msg + '</p>' +
          '<a href="/" style="color:var(--accent,#4f46e5);">ログインページへ</a>' +
          '</div>';
      }
    }

    // プロフィール取得
    showProgress();
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/';
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        hideProgress();
        if (!data) return; // 401の場合はリダイレクト中
        if (data.error) {
          showProfileError('プロフィールの取得に失敗しました。再度ログインしてください。');
          return;
        }
        var user = data.data;
        if (!user) {
          showProfileError('データの取得に失敗しました。再度ログインしてください。');
          return;
        }
        if (avatar) {
          avatar.src = user.picture || '';
          avatar.style.display = user.picture ? 'block' : 'none';
        }
        if (nameEl) nameEl.textContent = user.name;
        if (emailEl) emailEl.textContent = user.email;
        if (nameInput) nameInput.value = user.name;
        if (phoneInput) phoneInput.value = user.phone || '';
        if (addressInput) addressInput.value = user.address || '';
        if (loading) loading.style.display = 'none';
        if (card) card.style.display = 'block';
      })
      .catch(function () {
        showProfileError('通信エラーが発生しました。ページを再読み込みしてください。');
      });

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

        var phone = phoneInput ? phoneInput.value.trim() || null : null;
        var address = addressInput ? addressInput.value.trim() || null : null;

        showProgress();
        fetch('/api/me', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, phone: phone, address: address }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              showToast('更新に失敗しました', 'error');
            } else {
              if (nameEl) nameEl.textContent = data.data.name;
              if (nameInput) nameInput.value = data.data.name;
              if (phoneInput) phoneInput.value = data.data.phone || '';
              if (addressInput) addressInput.value = data.data.address || '';
              showToast('プロフィールを更新しました', 'success');
            }
          })
          .catch(function () {
            hideProgress();
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

  // 連携サービスページ
  if (path === '/connections.html') {
    var listEl = document.getElementById('connections-list');
    var loadingEl = document.getElementById('loading');
    var emptyEl = document.getElementById('empty-msg');
    var errorEl = document.getElementById('error-msg');

    function formatDate(iso) {
      return new Date(iso).toLocaleDateString('ja-JP');
    }

    function escHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function loadConnections() {
      showProgress();
      fetch('/api/connections', { credentials: 'same-origin' })
        .then(function (res) {
          if (res.status === 401) { window.location.href = '/'; return null; }
          return res.json();
        })
        .then(function (data) {
          hideProgress();
          if (!data) return;
          if (loadingEl) loadingEl.style.display = 'none';
          if (data.error) {
            if (errorEl) { errorEl.textContent = '連携サービスの取得に失敗しました'; errorEl.style.display = 'block'; }
            return;
          }
          var connections = data.data || [];
          if (connections.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            return;
          }
          if (listEl) {
            listEl.style.display = 'block';
            listEl.innerHTML = connections.map(function (c) {
              return '<div class="connection-item">' +
                '<div class="connection-info">' +
                  '<div class="connection-name">' + escHtml(c.service_name) + '</div>' +
                  '<div class="connection-meta">連携日: ' + formatDate(c.first_authorized_at) + '</div>' +
                '</div>' +
                '<button class="btn btn-danger btn-sm" data-id="' + escHtml(c.service_id) + '">解除</button>' +
              '</div>';
            }).join('');

            listEl.querySelectorAll('[data-id]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                if (!confirm('「' + btn.closest('.connection-item').querySelector('.connection-name').textContent + '」との連携を解除しますか？')) return;
                btn.disabled = true;
                showProgress();
                fetch('/api/connections/' + btn.dataset.id, {
                  method: 'DELETE',
                  credentials: 'same-origin',
                  headers: { Origin: window.location.origin },
                })
                  .then(function (res) {
                    hideProgress();
                    if (res.ok || res.status === 204) {
                      showToast('連携を解除しました', 'success');
                      loadConnections();
                    } else {
                      showToast('解除に失敗しました', 'error');
                      btn.disabled = false;
                    }
                  })
                  .catch(function () {
                    hideProgress();
                    showToast('通信エラーが発生しました', 'error');
                    btn.disabled = false;
                  });
              });
            });
          }
        })
        .catch(function () {
          hideProgress();
          if (loadingEl) loadingEl.style.display = 'none';
          if (errorEl) { errorEl.textContent = '通信エラーが発生しました'; errorEl.style.display = 'block'; }
        });
    }

    loadConnections();
  }
})();
