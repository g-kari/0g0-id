import { Hono } from 'hono';
import type { BffEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: BffEnv }>();

/**
 * URLを安全にHTMLエスケープする（href属性に挿入するため）。
 * URLはサーバーサイドで組み立てるためXSSリスクは低いが二重防御として実施。
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// GET /login — OAuth 2.0 / OIDC プロバイダー選択ページ（外部クライアント向け）
// IdP の /auth/authorize からリダイレクトされる。
// プロバイダー選択後は直接 IdP の /auth/login へリダイレクトし、
// 外部クライアントの redirect_uri に認可コードを返す。
app.get('/login', async (c) => {
  const clientId = c.req.query('client_id');
  const redirectUri = c.req.query('redirect_uri');
  const state = c.req.query('state');
  const codeChallenge = c.req.query('code_challenge');
  const codeChallengeMethod = c.req.query('code_challenge_method');
  const scope = c.req.query('scope');
  const nonce = c.req.query('nonce');

  // 必須パラメータ未指定の場合は通常のログインページへフォールバック
  if (!clientId || !redirectUri || !state || !codeChallenge) {
    return c.redirect('/');
  }

  // IdP /auth/login URL をプロバイダーごとに組み立てる
  // redirect_to には外部クライアントの redirect_uri を指定（BFF経由ではなくクライアント直接）
  const buildLoginUrl = (provider: string): string => {
    const url = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
    url.searchParams.set('provider', provider);
    url.searchParams.set('redirect_to', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', codeChallengeMethod ?? 'S256');
    if (scope) url.searchParams.set('scope', scope);
    if (nonce) url.searchParams.set('nonce', nonce);
    return url.toString();
  };

  const googleUrl = escapeHtml(buildLoginUrl('google'));
  const lineUrl = escapeHtml(buildLoginUrl('line'));
  const twitchUrl = escapeHtml(buildLoginUrl('twitch'));
  const githubUrl = escapeHtml(buildLoginUrl('github'));
  const xUrl = escapeHtml(buildLoginUrl('x'));

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>0g0 ID - ログイン</title>
  <meta name="description" content="0g0 ID にサインインしてください">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>0g0 ID</h1>
      <p class="subtitle">アカウントにサインインしてください</p>
      <div class="login-buttons">
        <a href="${googleUrl}" class="btn btn-google">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 6.294C4.672 4.169 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          Googleでサインイン
        </a>
        <a href="${lineUrl}" class="btn btn-line">
          <svg width="18" height="18" viewBox="0 0 36 36" fill="none" aria-hidden="true">
            <rect width="36" height="36" rx="8" fill="#06C755"/>
            <path d="M30 16.8C30 11.4 24.6 7 18 7S6 11.4 6 16.8c0 4.8 4.2 8.8 9.9 9.6.4.1.9.3 1 .6.1.3 0 .7 0 .7l-.2 1.2c-.1.3-.3 1.2 1 .7s7.2-4.2 9.8-7.2c1.8-2 2.5-4 2.5-5.6z" fill="white"/>
            <path d="M25.2 19.8h-3.9c-.2 0-.3-.1-.3-.3v-6c0-.2.1-.3.3-.3h3.9c.2 0 .3.1.3.3v1c0 .2-.1.3-.3.3h-2.6v1h2.6c.2 0 .3.1.3.3v1c0 .2-.1.3-.3.3h-2.6v1h2.6c.2 0 .3.1.3.3v1c0 .2-.1.3-.3.3zm-5.7 0h-1c-.2 0-.3-.1-.3-.3v-6c0-.2.1-.3.3-.3h1c.2 0 .3.1.3.3v6c0 .2-.1.3-.3.3zm-2.4 0h-1c-.2 0-.3-.1-.3-.3v-3.7l-2.5 3.8c-.1.1-.2.2-.3.2h-1c-.2 0-.3-.1-.3-.3v-6c0-.2.1-.3.3-.3h1c.2 0 .3.1.3.3v3.7l2.5-3.8c.1-.1.2-.2.3-.2h1c.2 0 .3.1.3.3v6c0 .2-.2.3-.3.3zm-6.5 0h-3.9c-.2 0-.3-.1-.3-.3v-6c0-.2.1-.3.3-.3h1c.2 0 .3.1.3.3v4.7h2.6c.2 0 .3.1.3.3v1c0 .2-.1.3-.3.3z" fill="#06C755"/>
          </svg>
          LINEでサインイン
        </a>
        <a href="${twitchUrl}" class="btn btn-twitch">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M11.64 5.93H13.07V10.21H11.64M15.57 5.93H17V10.21H15.57M7 2L3.43 5.57V18.43H7.71V22L11.29 18.43H14.14L20.57 12V2M19.14 11.29L16.29 14.14H13.43L10.93 16.64V14.14H7.71V3.43H19.14Z"/>
          </svg>
          Twitchでサインイン
        </a>
        <a href="${githubUrl}" class="btn btn-github">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
          </svg>
          GitHubでサインイン
        </a>
        <a href="${xUrl}" class="btn btn-x">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
          X（Twitter）でサインイン
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;

  return c.html(html);
});

export default app;
