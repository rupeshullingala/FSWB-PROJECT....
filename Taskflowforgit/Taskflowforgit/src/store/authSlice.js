import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { api, refreshSession, setAccessToken } from '../api.js';

// On page load: use the refresh cookie (if any) to get back into the session.
export const restoreSession = createAsyncThunk('auth/restore', async () => {
  const session = await refreshSession();
  return session ? session.user : null;
});

const authenticate = (path, body) => api(path, { method: 'POST', body }).then((d) => {
  setAccessToken(d.token);
  return d.user;
});

export const login = createAsyncThunk('auth/login', ({ email, password }) =>
  authenticate('/auth/login', { email, password }));

export const register = createAsyncThunk('auth/register', ({ name, email, password }) =>
  authenticate('/auth/register', { name, email, password }));

export const logout = createAsyncThunk('auth/logout', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* clearing locally is what matters */ }
  setAccessToken(null);
});

const slice = createSlice({
  name: 'auth',
  initialState: { user: null, checking: true },
  reducers: {
    // The server rejected us and the refresh cookie did not help.
    sessionExpired: (state) => { state.user = null; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(restoreSession.fulfilled, (state, { payload }) => { state.user = payload; state.checking = false; })
      .addCase(restoreSession.rejected, (state) => { state.checking = false; })
      .addCase(login.fulfilled, (state, { payload }) => { state.user = payload; })
      .addCase(register.fulfilled, (state, { payload }) => { state.user = payload; })
      .addCase(logout.fulfilled, (state) => { state.user = null; });
  },
});

export const { sessionExpired } = slice.actions;
export default slice.reducer;
