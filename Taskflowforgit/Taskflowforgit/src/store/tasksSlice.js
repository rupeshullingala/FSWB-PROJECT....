import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { api } from '../api.js';
import { logout, sessionExpired } from './authSlice.js';

const ACTIVE_KEY = 'taskflow-active-project';
export const readActiveProject = () => {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
};
export const saveActiveProject = (id) => {
  try { id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
};

const initialState = {
  projects: [], tasks: [], activity: [],
  activeProjectId: readActiveProject(),
  loading: true,
  notice: '',
};

// Every UI action becomes one API call. The server is the source of truth and answers with fresh state.
function toRequest(a) {
  switch (a.type) {
    case 'ADD_PROJECT': return ['/projects', 'POST', { name: a.name, memberEmails: a.members }];
    case 'DELETE_PROJECT': return [`/projects/${a.id}`, 'DELETE'];
    case 'ADD_MEMBER': return [`/projects/${a.projectId}/members`, 'POST', { email: a.email }];
    case 'ADD_TASK': return ['/tasks', 'POST', a.task];
    case 'UPDATE_TASK': return [`/tasks/${a.id}`, 'PATCH', a.changes];
    case 'MOVE_TASK': return [`/tasks/${a.id}/move`, 'POST', { status: a.status }];
    case 'TOGGLE_SUBTASK': return [`/tasks/${a.taskId}/subtasks/${a.subId}/toggle`, 'POST'];
    case 'DELETE_TASK': return [`/tasks/${a.id}`, 'DELETE'];
    default: throw new Error(`Unknown action ${a.type}`);
  }
}

export const fetchState = createAsyncThunk('tasks/fetchState', () => api('/state'));

export const performAction = createAsyncThunk('tasks/performAction', (action) => {
  const [path, method, body] = toRequest(action);
  return api(path, { method, body });
});

/** Dispatch this from a component; it resolves to true on success and false on failure (the error shows as a notice). */
export const act = (action) => async (dispatch) => performAction.fulfilled.match(await dispatch(performAction(action)));

export const sendRemindersNow = createAsyncThunk('tasks/sendReminders', async () => {
  return api('/reminders/run', { method: 'POST' });
});

function applyServerState(state, data) {
  state.projects = data.projects;
  state.tasks = data.tasks;
  state.activity = data.activity;
  let active = data.activeProjectId ?? state.activeProjectId;
  if (!state.projects.some((p) => p.id === active)) active = state.projects[0]?.id ?? null;
  state.activeProjectId = active;
}

const slice = createSlice({
  name: 'tasks',
  initialState,
  reducers: {
    selectProject: (state, { payload }) => { state.activeProjectId = payload; },
    // Used by the comments panel, whose API answers also carry the fresh state.
    receiveState: (state, { payload }) => applyServerState(state, payload),
    clearNotice: (state) => { state.notice = ''; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchState.fulfilled, (state, { payload }) => { applyServerState(state, payload); state.loading = false; })
      .addCase(fetchState.rejected, (state, { error }) => { state.notice = error.message; state.loading = false; })
      .addCase(performAction.pending, (state) => { state.notice = ''; })
      .addCase(performAction.fulfilled, (state, { payload }) => {
        applyServerState(state, payload);
        if (payload.warnings?.length) state.notice = payload.warnings.join('. ');
      })
      .addCase(performAction.rejected, (state, { error }) => { state.notice = error.message; })
      .addCase(sendRemindersNow.pending, (state) => { state.notice = ''; })
      .addCase(sendRemindersNow.fulfilled, (state, { payload: { processed, configured } }) => {
        if (!processed) {
          state.notice = 'No new reminders to send. A task needs an assignee, a deadline within the reminder window (or past), and reminders turned on.';
        } else if (!configured) {
          state.notice = `${processed} reminder(s) found, but NO email was sent because email is not set up on the server. Add BREVO_API_KEY or the SMTP_* values (see README, "Email setup") and restart.`;
        } else {
          state.notice = `${processed} reminder email(s) sent. Check the assignee's inbox (and spam).`;
        }
      })
      .addCase(sendRemindersNow.rejected, (state, { error }) => { state.notice = error.message; })
      // Leaving the session wipes the data so the next user never sees it.
      .addCase(logout.fulfilled, () => ({ ...initialState, activeProjectId: null }))
      .addCase(sessionExpired, () => ({ ...initialState, activeProjectId: null }));
  },
});

export const { selectProject, receiveState, clearNotice } = slice.actions;
export default slice.reducer;
