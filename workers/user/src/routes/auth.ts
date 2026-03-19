import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { generateToken, parseSession } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: BffEnv }>();

const SESSION_COOKIE = '__Host-user-session';
const STATE_COOKIE = '__Host-user-oauth-state';

// GET /auth/login
app.get('/login', async (c) => {
  const provider = c.req.query('provider') ?? 'google';
  const validProviders = ['google', 'line', 'twitch', 'github', 'x'];
  if (!validProviders.includes(provider)) {
    return c.redirect('/?error=invalid_provider');
  }

  const state = generateToken(16);

  const callbackUrl = `${new URL(c.req.url).origin}/auth/callback`;

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set('redirect_to', callbackUrl);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('provider', provider);

  return c.redirect(loginUrl.toString());
});

// GET /auth/callback
app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.redirect('/?error=missing_params');
  }

  const storedState = getCookie(c, STATE_COOKIE);

  if (!storedState) {
    return c.redirect('/?error=missing_session');
  }

  if (state !== storedState) {
    return c.redirect('/?error=state_mismatch');
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });

  // id worker にコード交換リクエスト（Service Bindings使用）
  const callbackUrl = `${new URL(c.req.url).origin}/auth/callback`;
  const exchangeRes = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_to: callbackUrl }),
    })
  );

  if (!exchangeRes.ok) {
    return c.redirect('/?error=exchange_failed');
  }

  const exchangeData = await exchangeRes.json<{
    data: {
      access_token: string;
      refresh_token: string;
      user: { id: string; email: string; name: string; role: string };
    };
  }>();

  // セッションCookieにトークンを保存
  const sessionData = btoa(
    encodeURIComponent(
      JSON.stringify({
        access_token: exchangeData.data.access_token,
        refresh_token: exchangeData.data.refresh_token,
        user: exchangeData.data.user,
      })
    )
  );

  setCookie(c, SESSION_COOKIE, sessionData, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30日
  });

  return c.redirect('/profile.html');
});

// POST /auth/logout
app.post('/logout', async (c) => {
  const session = getCookie(c, SESSION_COOKIE);
  if (session) {
    try {
      const data = JSON.parse(decodeURIComponent(atob(session))) as { refresh_token: string };
      await c.env.IDP.fetch(
        new Request(`${c.env.IDP_ORIGIN}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: data.refresh_token }),
        })
      );
    } catch (err) {
      // IdP側のトークン失効に失敗してもCookie削除は継続するが、ログに記録する
      console.error('[logout] IdP revoke request failed:', err);
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return c.redirect('/');
});

// GET /auth/link?provider=xxx — ログイン済みユーザーがSNSプロバイダー連携を開始
app.get('/link', async (c) => {
  const provider = c.req.query('provider') ?? 'google';
  const validProviders = ['google', 'line', 'twitch', 'github', 'x'];
  if (!validProviders.includes(provider)) {
    return c.redirect('/profile.html?error=invalid_provider');
  }

  // ログイン済みセッションからユーザーIDを取得
  const session = parseSession(getCookie(c, SESSION_COOKIE));
  if (!session) {
    return c.redirect('/?error=not_authenticated');
  }

  const state = generateToken(16);
  const callbackUrl = `${new URL(c.req.url).origin}/auth/callback`;

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set('redirect_to', callbackUrl);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('provider', provider);
  loginUrl.searchParams.set('link_user_id', session.user.id);

  return c.redirect(loginUrl.toString());
});

export default app;
export { SESSION_COOKIE };
