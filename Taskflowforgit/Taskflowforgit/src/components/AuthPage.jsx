import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { login, register } from '../store/authSlice.js';
import { api } from '../api.js';

export default function AuthPage() {
  const dispatch = useDispatch();
  const resetToken = new URLSearchParams(window.location.search).get('resetToken');
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      if (mode === 'forgot') {
        const result = await api('/auth/forgot-password', { method: 'POST', body: { email: form.email } });
        setNotice(result.message);
      } else if (mode === 'reset') {
        const result = await api('/auth/reset-password', { method: 'POST', body: { token: resetToken, password: form.password } });
        setNotice(result.message);
        window.history.replaceState({}, '', window.location.pathname);
        setMode('login'); setForm((f) => ({ ...f, password: '' }));
      } else if (mode === 'login') {
        await dispatch(login({ email: form.email, password: form.password })).unwrap();
      } else {
        await dispatch(register(form)).unwrap();
      }
    } catch (err) { setError(err.message || 'Something went wrong'); }
    finally { setBusy(false); }
  };

  const isLogin = mode === 'login';
  const title = mode === 'forgot' ? 'Forgot password?' : mode === 'reset' ? 'Choose a new password' : 'TaskFlow';
  const description = mode === 'forgot' ? 'Enter your account email and we’ll send you a reset link.' : mode === 'reset' ? 'Your reset link is valid for 30 minutes and can only be used once.' : isLogin ? 'Log in to your projects.' : 'Create an account to start a project.';

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-lg bg-white p-6 shadow-sm">
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-steel">{description}</p>

        {mode === 'register' && <label className="block text-sm">Name
          <input className="field mt-1" value={form.name} onChange={set('name')} required autoComplete="name" />
        </label>}
        {mode !== 'reset' && <label className="block text-sm">Email
          <input type="email" className="field mt-1" value={form.email} onChange={set('email')} required autoComplete="email" />
        </label>}
        {mode !== 'forgot' && <label className="block text-sm">{mode === 'reset' ? 'New password' : 'Password'}
          <input type="password" className="field mt-1" value={form.password} onChange={set('password')} required minLength={mode === 'reset' ? 8 : 6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'reset' && <span className="mt-1 block text-xs text-steel">Use at least 8 characters.</span>}
        </label>}

        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        {notice && <p role="status" className="text-sm text-teal-dark">{notice}</p>}
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? 'Please wait...' : mode === 'forgot' ? 'Send reset link' : mode === 'reset' ? 'Reset password' : isLogin ? 'Log in' : 'Sign up'}
        </button>

        {isLogin && <button type="button" className="w-full text-sm text-teal-dark underline" onClick={() => { setMode('forgot'); setError(''); setNotice(''); }}>Forgot password?</button>}
        {(mode === 'forgot' || mode === 'reset') && <button type="button" className="w-full text-sm text-teal-dark underline" onClick={() => { setMode('login'); setError(''); setNotice(''); window.history.replaceState({}, '', window.location.pathname); }}>Back to login</button>}
        {(isLogin || mode === 'register') && <button type="button" className="w-full text-sm text-teal-dark underline" onClick={() => { setMode(isLogin ? 'register' : 'login'); setError(''); setNotice(''); }}>
          {isLogin ? 'New here? Create an account' : 'Already have an account? Log in'}
        </button>}
      </form>
    </div>
  );
}
