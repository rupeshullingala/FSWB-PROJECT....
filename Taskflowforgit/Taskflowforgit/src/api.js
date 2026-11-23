// Fetch wrapper that handles JWTs.
//  - The short-lived access token is kept only in memory (not localStorage), so page scripts cannot steal a
//    long-lived credential. It is sent as "Authorization: Bearer ...".
//  - The long-lived refresh token is an HttpOnly cookie that JavaScript cannot read. When the access token
//    expires (or after a page reload) we call /auth/refresh to get a new one, then retry the request.

let accessToken = null;
export const setAccessToken = (t) => { accessToken = t; };

// Called when the session can no longer be renewed (the store clears the user and shows the login page).
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

const send = (path, { method = 'GET', body } = {}, token) =>
  fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const readJson = async (res) => {
  try { return await res.json(); } catch { return {}; }
};

// Several requests can fail at once; they all share one refresh call.
let refreshing = null;

/** Asks the server for a new access token using the refresh cookie. Resolves to { token, user } or null. */
export function refreshSession() {
  refreshing ??= send('/auth/refresh', { method: 'POST' })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await readJson(res);
      setAccessToken(data.token);
      return data;
    })
    .catch(() => null)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, options = {}) {
  let res = await send(path, options, accessToken);
  const isAuthRoute = path.startsWith('/auth/');
  if (res.status === 401 && !isAuthRoute) {
    if (await refreshSession()) res = await send(path, options, accessToken);
    else { setAccessToken(null); onUnauthorized(); }
  }
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
