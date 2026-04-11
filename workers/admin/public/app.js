"use strict";

(function () {
  // トースト通知
  function showToast(message, type) {
    var container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    var toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.transition = "opacity 0.3s";
      toast.style.opacity = "0";
      setTimeout(function () {
        toast.remove();
      }, 300);
    }, 3000);
  }

  // プログレスバー
  var _progressBar = null;
  var _progressTimer = null;
  var _progressResetTimer = null;
  var _progressCount = 0;

  function getProgressBar() {
    if (!_progressBar) {
      _progressBar = document.createElement("div");
      _progressBar.id = "progress-bar";
      document.body.insertBefore(_progressBar, document.body.firstChild);
    }
    return _progressBar;
  }

  function showProgress() {
    _progressCount++;
    var bar = getProgressBar();
    clearTimeout(_progressTimer);
    clearTimeout(_progressResetTimer);
    bar.style.transition = "none";
    bar.style.width = "0%";
    bar.style.opacity = "1";
    setTimeout(function () {
      bar.style.transition = "width 0.8s ease";
      bar.style.width = "75%";
    }, 16);
  }

  function hideProgress() {
    _progressCount = Math.max(0, _progressCount - 1);
    if (_progressCount > 0) return;
    var bar = getProgressBar();
    bar.style.transition = "width 0.15s ease";
    bar.style.width = "100%";
    _progressTimer = setTimeout(function () {
      bar.style.transition = "opacity 0.3s ease";
      bar.style.opacity = "0";
      _progressResetTimer = setTimeout(function () {
        bar.style.width = "0%";
      }, 300);
    }, 150);
  }

  // Cloudflare Workers Assets は .html 拡張子を除去するため正規化
  const path = window.location.pathname.replace(/\.html$/, "");

  // ログインページ
  if (path === "/" || path === "/index") {
    const params = new URLSearchParams(window.location.search);
    const errorEl = document.getElementById("error-msg");
    if (params.get("error") && errorEl) {
      const messages = {
        missing_params: "パラメータが不足しています",
        missing_session: "セッションが見つかりません",
        state_mismatch: "セキュリティエラーが発生しました",
        exchange_failed: "認証に失敗しました",
        not_admin: "管理者アカウントではありません",
      };
      errorEl.textContent = messages[params.get("error")] || "認証エラーが発生しました";
      errorEl.style.display = "block";
    }
    return;
  }

  // ログアウトボタン（共通）
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
        .then(function () {
          window.location.href = "/";
        })
        .catch(function () {
          window.location.href = "/";
        });
    });
  }

  function showMsg(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = "alert alert-" + type;
    el.style.display = "block";
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString("ja-JP");
  }

  var SPINNER_HTML = '<span class="spinner"></span>';
  var LOADING_HTML =
    '<div class="loading-center">' + SPINNER_HTML + "<span>読み込み中...</span></div>";

  // ダッシュボード
  if (path === "/dashboard") {
    showProgress();
    fetch("/api/metrics", { credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) {
          hideProgress();
          window.location.href = "/";
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        hideProgress();
        if (!data || data.error) return;
        var m = data.data;
        var totalUsersEl = document.getElementById("metric-total-users");
        var adminUsersEl = document.getElementById("metric-admin-users");
        var bannedUsersEl = document.getElementById("metric-banned-users");
        var totalServicesEl = document.getElementById("metric-total-services");
        var activeSessionsEl = document.getElementById("metric-active-sessions");
        var recentLogins24hEl = document.getElementById("metric-recent-logins-24h");
        var recentLogins7dEl = document.getElementById("metric-recent-logins-7d");
        if (totalUsersEl) totalUsersEl.textContent = m.total_users;
        if (adminUsersEl) adminUsersEl.textContent = m.admin_users;
        if (bannedUsersEl) bannedUsersEl.textContent = m.banned_users;
        if (totalServicesEl) totalServicesEl.textContent = m.total_services;
        if (activeSessionsEl) activeSessionsEl.textContent = m.active_sessions;
        if (recentLogins24hEl) recentLogins24hEl.textContent = m.recent_logins_24h;
        if (recentLogins7dEl) recentLogins7dEl.textContent = m.recent_logins_7d;
      })
      .catch(function () {
        hideProgress(); /* メトリクス取得失敗は無視 */
      });
  }

  // サービス管理ページ
  if (path === "/services") {
    const tbody = document.getElementById("services-body");
    const msgEl = document.getElementById("msg");
    const addModal = document.getElementById("add-modal");
    const secretModal = document.getElementById("secret-modal");
    const addForm = document.getElementById("add-form");
    const addBtn = document.getElementById("add-service-btn");
    const cancelBtn = document.getElementById("cancel-btn");
    const closeSecretBtn = document.getElementById("close-secret-btn");

    // リダイレクトURI管理
    const uriModal = document.getElementById("uri-modal");
    const uriModalServiceName = document.getElementById("uri-modal-service-name");
    const uriList = document.getElementById("uri-list");
    const uriAddForm = document.getElementById("uri-add-form");
    const uriInput = document.getElementById("uri-input");
    const uriCloseBtn = document.getElementById("uri-close-btn");
    var currentServiceId = null;

    function loadUris(serviceId) {
      if (!uriList) return;
      uriList.innerHTML = LOADING_HTML;
      showProgress();
      fetch("/api/services/" + serviceId + "/redirect-uris", { credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          hideProgress();
          if (data.error) {
            uriList.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
            return;
          }
          var uris = data.data || [];
          if (uris.length === 0) {
            uriList.innerHTML =
              '<p style="color:var(--text-muted);font-size:0.875rem;">URIが登録されていません</p>';
            return;
          }
          uriList.innerHTML = uris
            .map(function (u) {
              return (
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);">' +
                '<span class="mono" style="font-size:0.8125rem;word-break:break-all;flex:1;">' +
                escHtml(u.uri) +
                "</span>" +
                '<button class="btn btn-danger btn-sm" style="margin-left:0.5rem;flex-shrink:0;" data-uri-id="' +
                escHtml(u.id) +
                '">削除</button>' +
                "</div>"
              );
            })
            .join("");
          uriList.querySelectorAll("[data-uri-id]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              if (!confirm("このURIを削除しますか？")) return;
              showProgress();
              fetch("/api/services/" + currentServiceId + "/redirect-uris/" + btn.dataset.uriId, {
                method: "DELETE",
                credentials: "same-origin",
              })
                .then(function (r) {
                  hideProgress();
                  if (r.ok || r.status === 204) {
                    showToast("URIを削除しました", "success");
                    loadUris(currentServiceId);
                  } else {
                    showToast("削除に失敗しました", "error");
                  }
                })
                .catch(function () {
                  hideProgress();
                  showToast("通信エラーが発生しました", "error");
                });
            });
          });
        })
        .catch(function () {
          hideProgress();
          uriList.innerHTML =
            '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
        });
    }

    if (uriCloseBtn && uriModal) {
      uriCloseBtn.addEventListener("click", function () {
        uriModal.hidden = true;
        currentServiceId = null;
      });
    }

    if (uriAddForm) {
      uriAddForm.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!currentServiceId || !uriInput) return;
        var uri = uriInput.value.trim();
        if (!uri) return;
        showProgress();
        fetch("/api/services/" + currentServiceId + "/redirect-uris", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uri: uri }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              showToast(
                data.error.code === "CONFLICT"
                  ? "このURIは既に登録されています"
                  : "URIの追加に失敗しました",
                "error",
              );
            } else {
              uriInput.value = "";
              showToast("URIを追加しました", "success");
              loadUris(currentServiceId);
            }
          })
          .catch(function () {
            hideProgress();
            showToast("通信エラーが発生しました", "error");
          });
      });
    }

    function showServicesError(msg) {
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="4" style="text-align:center;color:var(--error);">' +
          escHtml(msg) +
          "</td></tr>";
    }

    function loadServices() {
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="4" style="padding:0;border:none;">' +
          '<div class="loading-center">' +
          SPINNER_HTML +
          "<span>読み込み中...</span></div></td></tr>";
      showProgress();
      fetch("/api/services", { credentials: "same-origin" })
        .then(function (r) {
          if (r.status === 401) {
            hideProgress();
            showServicesError("セッションが無効です。再度ログインしてください。");
            setTimeout(function () {
              window.location.href = "/";
            }, 1500);
            return null;
          }
          return r.json();
        })
        .then(function (data) {
          hideProgress();
          if (!data) return;
          if (data.error) {
            showMsg(msgEl, "サービスの取得に失敗しました", "error");
            showToast("サービスの取得に失敗しました", "error");
            return;
          }
          const rows = data.data
            .map(function (s) {
              return (
                "<tr>" +
                "<td>" +
                escHtml(s.name) +
                "</td>" +
                '<td class="mono">' +
                escHtml(s.client_id) +
                "</td>" +
                "<td>" +
                formatDate(s.created_at) +
                "</td>" +
                '<td style="white-space:nowrap;">' +
                '<button class="btn btn-secondary btn-sm mr-1" data-users-service-id="' +
                escHtml(s.id) +
                '" data-users-service-name="' +
                escHtml(s.name) +
                '">ユーザー</button>' +
                '<button class="btn btn-accent btn-sm mr-1" data-uri-service-id="' +
                escHtml(s.id) +
                '" data-uri-service-name="' +
                escHtml(s.name) +
                '">URI管理</button>' +
                '<button class="btn btn-danger btn-sm" data-id="' +
                escHtml(s.id) +
                '">削除</button>' +
                "</td>" +
                "</tr>"
              );
            })
            .join("");
          if (tbody)
            tbody.innerHTML =
              rows ||
              '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">サービスなし</td></tr>';

          // 削除ボタン
          if (tbody) {
            tbody.querySelectorAll("[data-id]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                if (!confirm("このサービスを削除しますか？")) return;
                showProgress();
                fetch("/api/services/" + btn.dataset.id, {
                  method: "DELETE",
                  credentials: "same-origin",
                })
                  .then(function (r) {
                    hideProgress();
                    if (r.ok || r.status === 204) {
                      showToast("サービスを削除しました", "success");
                      loadServices();
                    } else {
                      showToast("削除に失敗しました", "error");
                    }
                  })
                  .catch(function () {
                    hideProgress();
                    showToast("通信エラーが発生しました", "error");
                  });
              });
            });

            // URI管理ボタン
            tbody.querySelectorAll("[data-uri-service-id]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                currentServiceId = btn.dataset.uriServiceId;
                if (uriModalServiceName)
                  uriModalServiceName.textContent = "サービス: " + btn.dataset.uriServiceName;
                if (uriInput) uriInput.value = "";
                if (uriModal) uriModal.hidden = false;
                loadUris(currentServiceId);
              });
            });

            // ユーザー一覧ボタン
            tbody.querySelectorAll("[data-users-service-id]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                openServiceUsers(btn.dataset.usersServiceId, btn.dataset.usersServiceName);
              });
            });
          }
        })
        .catch(function () {
          hideProgress();
          showServicesError("通信エラーが発生しました");
          showMsg(msgEl, "通信エラーが発生しました", "error");
        });
    }

    loadServices();

    if (addBtn && addModal) {
      addBtn.addEventListener("click", function () {
        addModal.hidden = false;
      });
    }
    if (cancelBtn && addModal) {
      cancelBtn.addEventListener("click", function () {
        addModal.hidden = true;
      });
    }

    if (addForm) {
      addForm.addEventListener("submit", function (e) {
        e.preventDefault();
        const name = document.getElementById("service-name").value.trim();
        if (!name) return;

        showProgress();
        fetch("/api/services", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              showToast("作成に失敗しました", "error");
              return;
            }
            if (addModal) addModal.hidden = true;
            addForm.reset();
            // シークレット表示
            const cidBox = document.getElementById("client-id-box");
            const csBox = document.getElementById("client-secret-box");
            if (cidBox) cidBox.textContent = data.data.client_id;
            if (csBox) csBox.textContent = data.data.client_secret;
            if (secretModal) secretModal.hidden = false;
            loadServices();
          })
          .catch(function () {
            hideProgress();
            showToast("通信エラーが発生しました", "error");
          });
      });
    }

    if (closeSecretBtn && secretModal) {
      closeSecretBtn.addEventListener("click", function () {
        secretModal.hidden = true;
      });
    }

    // サービスユーザー一覧モーダル
    var serviceUsersModal = document.getElementById("service-users-modal");
    var serviceUsersTitle = document.getElementById("service-users-title");
    var serviceUsersContent = document.getElementById("service-users-content");
    var serviceUsersCloseBtn = document.getElementById("service-users-close-btn");

    function openServiceUsers(serviceId, serviceName) {
      if (serviceUsersTitle) serviceUsersTitle.textContent = serviceName + " のユーザー";
      if (serviceUsersContent) serviceUsersContent.innerHTML = LOADING_HTML;
      if (serviceUsersModal) serviceUsersModal.hidden = false;
      showProgress();
      fetch("/api/services/" + serviceId + "/users", { credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          hideProgress();
          if (!serviceUsersContent) return;
          if (data.error) {
            serviceUsersContent.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
            return;
          }
          var items = data.data || [];
          if (items.length === 0) {
            serviceUsersContent.innerHTML =
              '<p style="color:var(--text-muted);font-size:0.875rem;">このサービスを認可したユーザーがいません</p>';
            return;
          }
          serviceUsersContent.innerHTML =
            '<div class="table-wrap"><table aria-label="サービス認可ユーザー一覧">' +
            "<thead><tr><th>名前</th><th>メール</th><th>ロール</th><th>登録日</th></tr></thead>" +
            "<tbody>" +
            items
              .map(function (u) {
                var roleBadge =
                  u.role === "admin"
                    ? '<span class="badge badge-admin">admin</span>'
                    : '<span class="badge badge-user">user</span>';
                return (
                  "<tr>" +
                  "<td>" +
                  escHtml(u.name || "—") +
                  "</td>" +
                  "<td>" +
                  escHtml(u.email) +
                  "</td>" +
                  "<td>" +
                  roleBadge +
                  "</td>" +
                  "<td>" +
                  new Date(u.created_at).toLocaleString("ja-JP") +
                  "</td>" +
                  "</tr>"
                );
              })
              .join("") +
            "</tbody></table></div>";
        })
        .catch(function () {
          hideProgress();
          if (serviceUsersContent)
            serviceUsersContent.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
        });
    }

    if (serviceUsersCloseBtn && serviceUsersModal) {
      serviceUsersCloseBtn.addEventListener("click", function () {
        serviceUsersModal.hidden = true;
      });
    }

    if (serviceUsersModal) {
      serviceUsersModal.addEventListener("click", function (e) {
        if (e.target === serviceUsersModal) serviceUsersModal.hidden = true;
      });
    }
  }

  // ユーザー管理ページ
  if (path === "/users") {
    const tbody = document.getElementById("users-body");

    function showUsersError(msg) {
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:var(--error);">' +
          escHtml(msg) +
          "</td></tr>";
      showToast(msg, "error");
    }

    var currentBannedFilter = "";

    function loadUsers() {
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="6" style="padding:0;border:none;">' +
          '<div class="loading-center">' +
          SPINNER_HTML +
          "<span>読み込み中...</span></div></td></tr>";

      var url = "/api/users";
      if (currentBannedFilter) url += "?banned=" + currentBannedFilter;
      showProgress();
      fetch(url, { credentials: "same-origin" })
        .then(function (r) {
          if (r.status === 401) {
            hideProgress();
            showUsersError("セッションが無効です。再度ログインしてください。");
            setTimeout(function () {
              window.location.href = "/";
            }, 1500);
            return null;
          }
          return r.json();
        })
        .then(function (data) {
          hideProgress();
          if (!data) return;
          if (data.error) {
            showUsersError("ユーザーの取得に失敗しました");
            return;
          }
          if (!data.data) {
            showUsersError("データの形式が不正です");
            return;
          }
          const rows = data.data
            .map(function (u) {
              const badge =
                u.role === "admin"
                  ? '<span class="badge badge-admin">admin</span>'
                  : '<span class="badge badge-user">user</span>';
              const roleLabel = u.role === "admin" ? "userへ変更" : "adminへ変更";
              const newRole = u.role === "admin" ? "user" : "admin";
              const isBanned = !!u.banned_at;
              const statusBadge = isBanned
                ? '<span class="badge badge-danger">停止中</span>'
                : '<span class="badge" style="background:var(--success,#22c55e);color:#fff;">正常</span>';
              const banBtnLabel = isBanned ? "解除" : "停止";
              const banBtnClass = isBanned ? "btn-accent" : "btn-warning";
              return (
                "<tr>" +
                "<td>" +
                escHtml(u.name) +
                "</td>" +
                "<td>" +
                escHtml(u.email) +
                "</td>" +
                "<td>" +
                badge +
                "</td>" +
                "<td>" +
                statusBadge +
                "</td>" +
                "<td>" +
                formatDate(u.created_at) +
                "</td>" +
                '<td style="white-space:nowrap;">' +
                '<button class="btn btn-secondary btn-sm mr-1" ' +
                'data-detail-id="' +
                escHtml(u.id) +
                '" data-detail-name="' +
                escHtml(u.name) +
                '">詳細</button>' +
                '<button class="btn btn-accent btn-sm mr-1" ' +
                'data-role-id="' +
                escHtml(u.id) +
                '" data-role-new="' +
                newRole +
                '" data-role-name="' +
                escHtml(u.name) +
                '">' +
                roleLabel +
                "</button>" +
                '<button class="btn ' +
                banBtnClass +
                ' btn-sm mr-1" ' +
                'data-ban-id="' +
                escHtml(u.id) +
                '" data-ban-name="' +
                escHtml(u.name) +
                '" data-ban-action="' +
                (isBanned ? "unban" : "ban") +
                '">' +
                banBtnLabel +
                "</button>" +
                '<button class="btn btn-danger btn-sm" data-del-id="' +
                escHtml(u.id) +
                '" data-del-name="' +
                escHtml(u.name) +
                '">削除</button>' +
                "</td>" +
                "</tr>"
              );
            })
            .join("");
          if (tbody)
            tbody.innerHTML =
              rows ||
              '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">ユーザーなし</td></tr>';
        })
        .catch(function () {
          hideProgress();
          showUsersError("通信エラーが発生しました");
        });
    }

    // イベント委譲: tbody への click 1件で全ボタンを処理
    if (tbody) {
      tbody.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-detail-id]");
        if (btn) {
          openUserDetail(btn.dataset.detailId, btn.dataset.detailName);
          return;
        }

        btn = e.target.closest("[data-role-id]");
        if (btn) {
          var newRole = btn.dataset.roleNew;
          var name = btn.dataset.roleName;
          if (!confirm("「" + name + "」のロールを " + newRole + " に変更しますか？")) return;
          btn.disabled = true;
          showProgress();
          fetch("/api/users/" + btn.dataset.roleId + "/role", {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: newRole }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (data) {
              hideProgress();
              if (data.error) {
                showToast("ロール変更に失敗しました: " + (data.error.message || ""), "error");
                btn.disabled = false;
              } else {
                showToast("ロールを " + newRole + " に変更しました", "success");
                loadUsers();
              }
            })
            .catch(function () {
              hideProgress();
              showToast("通信エラーが発生しました", "error");
              btn.disabled = false;
            });
          return;
        }

        btn = e.target.closest("[data-ban-id]");
        if (btn) {
          var banName = btn.dataset.banName;
          var banAction = btn.dataset.banAction;
          var banConfirmMsg =
            banAction === "ban"
              ? "「" + banName + "」のアカウントを停止しますか？ログイン不可になります。"
              : "「" + banName + "」のアカウント停止を解除しますか？";
          if (!confirm(banConfirmMsg)) return;
          btn.disabled = true;
          showProgress();
          var banMethod = banAction === "ban" ? "PATCH" : "DELETE";
          fetch("/api/users/" + btn.dataset.banId + "/ban", {
            method: banMethod,
            credentials: "same-origin",
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (data) {
              hideProgress();
              if (data.error) {
                showToast(
                  (banAction === "ban" ? "停止" : "解除") +
                    "に失敗しました: " +
                    (data.error.message || ""),
                  "error",
                );
                btn.disabled = false;
              } else {
                showToast(
                  banAction === "ban" ? "アカウントを停止しました" : "アカウント停止を解除しました",
                  "success",
                );
                loadUsers();
              }
            })
            .catch(function () {
              hideProgress();
              showToast("通信エラーが発生しました", "error");
              btn.disabled = false;
            });
          return;
        }

        btn = e.target.closest("[data-del-id]");
        if (btn) {
          var delName = btn.dataset.delName;
          if (!confirm("「" + delName + "」を削除しますか？この操作は取り消せません。")) return;
          btn.disabled = true;
          showProgress();
          fetch("/api/users/" + btn.dataset.delId, {
            method: "DELETE",
            credentials: "same-origin",
          })
            .then(function (r) {
              hideProgress();
              if (r.ok || r.status === 204) {
                showToast("ユーザーを削除しました", "success");
                loadUsers();
              } else {
                return r.json().then(function (data) {
                  showToast("削除に失敗しました: " + (data.error?.message || ""), "error");
                  btn.disabled = false;
                });
              }
            })
            .catch(function () {
              hideProgress();
              showToast("通信エラーが発生しました", "error");
              btn.disabled = false;
            });
        }
      });
    }

    // bannedフィルター
    var bannedFilterEl = document.getElementById("banned-filter");
    if (bannedFilterEl) {
      bannedFilterEl.addEventListener("change", function () {
        currentBannedFilter = bannedFilterEl.value;
        loadUsers();
      });
    }

    loadUsers();

    // ユーザー詳細モーダル
    var loadedDetailTabs = {};
    var currentDetailUserId = null;
    var detailModal = document.getElementById("user-detail-modal");
    var detailTitle = document.getElementById("user-detail-title");
    var detailCloseBtn = document.getElementById("user-detail-close-btn");
    var tabPanels = {
      profile: document.getElementById("tab-profile"),
      "login-history": document.getElementById("tab-login-history"),
      providers: document.getElementById("tab-providers"),
      services: document.getElementById("tab-services"),
      sessions: document.getElementById("tab-sessions"),
    };
    var tabBtns = detailModal ? detailModal.querySelectorAll(".tab-btn") : [];

    function showDetailTab(tabName) {
      tabBtns.forEach(function (btn) {
        var isActive = btn.dataset.tab === tabName;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      Object.keys(tabPanels).forEach(function (key) {
        if (tabPanels[key]) tabPanels[key].hidden = key !== tabName;
      });
      if (!loadedDetailTabs[tabName] && currentDetailUserId) {
        loadDetailTab(tabName, currentDetailUserId);
      }
    }

    function loadDetailTab(tabName, userId) {
      loadedDetailTabs[tabName] = true;
      var panel = tabPanels[tabName];
      if (!panel) return;

      if (tabName === "profile") {
        panel.innerHTML = LOADING_HTML;
        showProgress();
        fetch("/api/users/" + userId, { credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              panel.innerHTML =
                '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
              return;
            }
            var u = data.data || data;
            var verifiedBadge = u.email_verified
              ? '<span class="badge badge-admin" style="margin-left:0.375rem;">確認済み</span>'
              : '<span class="badge badge-user" style="margin-left:0.375rem;">未確認</span>';
            var roleBadge =
              u.role === "admin"
                ? '<span class="badge badge-admin">admin</span>'
                : '<span class="badge badge-user">user</span>';
            var bannedRow = u.banned_at
              ? '<div class="detail-row"><span class="detail-label">停止日時</span><span class="detail-value" style="color:var(--error);">' +
                new Date(u.banned_at).toLocaleString("ja-JP") +
                ' <span class="badge badge-danger">停止中</span></span></div>'
              : "";
            panel.innerHTML =
              '<div class="detail-row"><span class="detail-label">内部ID</span><span class="detail-value mono">' +
              escHtml(u.id) +
              "</span></div>" +
              '<div class="detail-row"><span class="detail-label">名前</span><span class="detail-value">' +
              escHtml(u.name || "—") +
              "</span></div>" +
              '<div class="detail-row"><span class="detail-label">メール</span><span class="detail-value">' +
              escHtml(u.email) +
              verifiedBadge +
              "</span></div>" +
              '<div class="detail-row"><span class="detail-label">ロール</span><span class="detail-value">' +
              roleBadge +
              "</span></div>" +
              bannedRow +
              '<div class="detail-row"><span class="detail-label">登録日時</span><span class="detail-value">' +
              new Date(u.created_at).toLocaleString("ja-JP") +
              "</span></div>" +
              '<div class="detail-row"><span class="detail-label">更新日時</span><span class="detail-value">' +
              new Date(u.updated_at).toLocaleString("ja-JP") +
              "</span></div>";
          })
          .catch(function () {
            hideProgress();
            panel.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
          });
        return;
      }

      if (tabName === "login-history") {
        panel.innerHTML = LOADING_HTML;
        showProgress();
        fetch("/api/users/" + userId + "/login-history", { credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              panel.innerHTML =
                '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
              return;
            }
            var items = data.data || [];
            if (items.length === 0) {
              panel.innerHTML =
                '<p style="color:var(--text-muted);font-size:0.875rem;">ログイン履歴がありません</p>';
              return;
            }
            panel.innerHTML =
              '<div class="table-wrap"><table aria-label="ログイン履歴">' +
              "<thead><tr><th>プロバイダー</th><th>IPアドレス</th><th>日時</th></tr></thead>" +
              "<tbody>" +
              items
                .map(function (item) {
                  return (
                    "<tr>" +
                    "<td>" +
                    escHtml(item.provider || "—") +
                    "</td>" +
                    '<td class="mono">' +
                    escHtml(item.ip_address || "—") +
                    "</td>" +
                    "<td>" +
                    new Date(item.created_at).toLocaleString("ja-JP") +
                    "</td>" +
                    "</tr>"
                  );
                })
                .join("") +
              "</tbody></table></div>";
          })
          .catch(function () {
            hideProgress();
            panel.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
          });
        return;
      }

      if (tabName === "providers") {
        panel.innerHTML = LOADING_HTML;
        showProgress();
        fetch("/api/users/" + userId + "/providers", { credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              panel.innerHTML =
                '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
              return;
            }
            var items = data.data || [];
            if (items.length === 0) {
              panel.innerHTML =
                '<p style="color:var(--text-muted);font-size:0.875rem;">連携プロバイダーがありません</p>';
              return;
            }
            panel.innerHTML = items
              .map(function (item) {
                var badge = item.connected
                  ? '<span class="badge badge-admin">連携済み</span>'
                  : '<span class="badge badge-user">未連携</span>';
                return (
                  '<div class="detail-row">' +
                  '<span class="detail-label">' +
                  escHtml(item.provider) +
                  "</span>" +
                  '<span class="detail-value">' +
                  badge +
                  "</span>" +
                  "</div>"
                );
              })
              .join("");
          })
          .catch(function () {
            hideProgress();
            panel.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
          });
        return;
      }

      if (tabName === "services") {
        panel.innerHTML = LOADING_HTML;
        showProgress();
        fetch("/api/users/" + userId + "/services", { credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              panel.innerHTML =
                '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
              return;
            }
            var items = data.data || [];
            if (items.length === 0) {
              panel.innerHTML =
                '<p style="color:var(--text-muted);font-size:0.875rem;">認可済みサービスがありません</p>';
              return;
            }
            // ペアワイズ sub = sha256(client_id:userId) をブラウザ WebCrypto で算出
            return Promise.all(
              items.map(function (item) {
                var raw = new TextEncoder().encode(item.client_id + ":" + userId);
                return crypto.subtle.digest("SHA-256", raw).then(function (buf) {
                  var hex = Array.from(new Uint8Array(buf))
                    .map(function (b) {
                      return b.toString(16).padStart(2, "0");
                    })
                    .join("");
                  return Object.assign({}, item, { pairwise_sub: hex });
                });
              }),
            ).then(function (itemsWithSub) {
              panel.innerHTML =
                '<div class="table-wrap"><table aria-label="認可済みサービス">' +
                "<thead><tr><th>サービス名</th><th>ペアワイズ sub</th><th>初回認可日</th><th>最終認可日</th></tr></thead>" +
                "<tbody>" +
                itemsWithSub
                  .map(function (item) {
                    return (
                      "<tr>" +
                      "<td>" +
                      escHtml(item.service_name || "—") +
                      "</td>" +
                      '<td class="mono" style="font-size:0.7rem;word-break:break-all;">' +
                      escHtml(item.pairwise_sub) +
                      "</td>" +
                      "<td>" +
                      new Date(item.first_authorized_at).toLocaleString("ja-JP") +
                      "</td>" +
                      "<td>" +
                      new Date(item.last_authorized_at).toLocaleString("ja-JP") +
                      "</td>" +
                      "</tr>"
                    );
                  })
                  .join("") +
                "</tbody></table></div>";
            });
          })
          .catch(function () {
            hideProgress();
            panel.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
          });
        return;
      }

      if (tabName === "sessions") {
        panel.innerHTML = LOADING_HTML;
        showProgress();
        fetch("/api/users/" + userId + "/tokens", { credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            hideProgress();
            if (data.error) {
              panel.innerHTML =
                '<p style="color:var(--error);font-size:0.875rem;">取得に失敗しました</p>';
              return;
            }
            var items = data.data || [];
            var tableHtml =
              items.length === 0
                ? '<p style="color:var(--text-muted);font-size:0.875rem;margin-bottom:1rem;">アクティブなセッションがありません</p>'
                : '<div class="table-wrap" style="margin-bottom:1rem;"><table aria-label="セッション一覧">' +
                  "<thead><tr><th>サービス</th><th>作成日時</th><th>有効期限</th></tr></thead>" +
                  "<tbody>" +
                  items
                    .map(function (item) {
                      return (
                        "<tr>" +
                        "<td>" +
                        escHtml(item.service_name || "IdPセッション") +
                        "</td>" +
                        "<td>" +
                        new Date(item.created_at).toLocaleString("ja-JP") +
                        "</td>" +
                        "<td>" +
                        new Date(item.expires_at).toLocaleString("ja-JP") +
                        "</td>" +
                        "</tr>"
                      );
                    })
                    .join("") +
                  "</tbody></table></div>";
            panel.innerHTML =
              tableHtml +
              '<button class="btn btn-danger btn-sm" id="revoke-all-btn">全セッション無効化</button>';
            var revokeBtn = panel.querySelector("#revoke-all-btn");
            if (revokeBtn) {
              revokeBtn.addEventListener("click", function () {
                if (!confirm("このユーザーの全セッションを無効化しますか？")) return;
                revokeBtn.disabled = true;
                showProgress();
                fetch("/api/users/" + userId + "/tokens", {
                  method: "DELETE",
                  credentials: "same-origin",
                })
                  .then(function (r) {
                    hideProgress();
                    if (r.ok || r.status === 204) {
                      showToast("全セッションを無効化しました", "success");
                      delete loadedDetailTabs["sessions"];
                      loadDetailTab("sessions", userId);
                    } else {
                      showToast("無効化に失敗しました", "error");
                      revokeBtn.disabled = false;
                    }
                  })
                  .catch(function () {
                    hideProgress();
                    showToast("通信エラーが発生しました", "error");
                    revokeBtn.disabled = false;
                  });
              });
            }
          })
          .catch(function () {
            hideProgress();
            panel.innerHTML =
              '<p style="color:var(--error);font-size:0.875rem;">通信エラーが発生しました</p>';
          });
      }
    }

    function openUserDetail(userId, userName) {
      currentDetailUserId = userId;
      loadedDetailTabs = {};
      if (detailTitle) detailTitle.textContent = userName;
      // 全タブパネルを空にする
      Object.keys(tabPanels).forEach(function (key) {
        if (tabPanels[key]) {
          tabPanels[key].innerHTML = "";
          tabPanels[key].hidden = true;
        }
      });
      if (detailModal) detailModal.hidden = false;
      showDetailTab("profile");
    }

    if (detailCloseBtn && detailModal) {
      detailCloseBtn.addEventListener("click", function () {
        detailModal.hidden = true;
        currentDetailUserId = null;
        loadedDetailTabs = {};
      });
    }

    if (detailModal) {
      detailModal.addEventListener("click", function (e) {
        if (e.target === detailModal) {
          detailModal.hidden = true;
          currentDetailUserId = null;
          loadedDetailTabs = {};
        }
      });

      tabBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          showDetailTab(btn.dataset.tab);
        });
      });
    }
  }
})();
