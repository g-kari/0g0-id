import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { generateCodeVerifier, generateCodeChallenge, generateToken } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: BffEnv }>();

const SESSION_COOKIE = '__Host-admin-session';
const STATE_COOKIE = '__Host-admin-oauth-state';
const PKCE_COOKIE = '__Host-admin-pkce';

// GET /auth/login
app.get('/login', async (c) => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateToken(16);

  const callbackUrl = `${c.req.url.split('/auth/login')[0]}/auth/callback`;

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });
  setCookie(c, PKCE_COOKIE, codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set('redirect_to', callbackUrl);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('code_challenge', codeChallenge);

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
  const codeVerifier = getCookie(c, PKCE_COOKIE);

  if (!storedState || !codeVerifier) {
    return c.redirect('/?error=missing_session');
  }

  if (state !== storedState) {
    return c.redirect('/?error=state_mismatch');
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: '/', secure: true });

  const exchangeRes = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
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

  // 管理者チェック
  if (exchangeData.data.user.role !== 'admin') {
    return c.redirect('/?error=not_admin');
  }

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
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.redirect('/dashboard.html');
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
    } catch {
      // ignore
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/');
});

export default app;
export { SESSION_COOKIE };
