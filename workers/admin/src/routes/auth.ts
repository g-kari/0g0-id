import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { generateToken, parseSession, setSessionCookie, timingSafeEqual } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: BffEnv }>();

const SESSION_COOKIE = '__Host-admin-session';
const STATE_COOKIE = '__Host-admin-oauth-state';

// GET /auth/login
app.get('/login', async (c) => {
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

  if (!timingSafeEqual(state, storedState)) {
    return c.redirect('/?error=state_mismatch');
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });

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
      user: { id: string; email: string; name: string; role: 'user' | 'admin' };
    };
  }>();

  // 管理者チェック
  if (exchangeData.data.user.role !== 'admin') {
    return c.redirect('/?error=not_admin');
  }

  await setSessionCookie(c, SESSION_COOKIE, {
    access_token: exchangeData.data.access_token,
    refresh_token: exchangeData.data.refresh_token,
    user: exchangeData.data.user,
  });

  return c.redirect('/dashboard.html');
});

// POST /auth/logout
app.post('/logout', async (c) => {
  const session = getCookie(c, SESSION_COOKIE);
  const sessionData = await parseSession(session, c.env.SESSION_SECRET);
  if (sessionData) {
    try {
      await c.env.IDP.fetch(
        new Request(`${c.env.IDP_ORIGIN}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: sessionData.refresh_token }),
        })
      );
    } catch {
      // ignore
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return c.redirect('/');
});

export default app;
export { SESSION_COOKIE };
