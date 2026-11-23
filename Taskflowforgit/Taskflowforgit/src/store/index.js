import { configureStore } from '@reduxjs/toolkit';
import { setUnauthorizedHandler } from '../api.js';
import authReducer, { sessionExpired } from './authSlice.js';
import tasksReducer, { saveActiveProject } from './tasksSlice.js';
import weatherReducer from './weatherSlice.js';

export const store = configureStore({
  reducer: { auth: authReducer, tasks: tasksReducer, weather: weatherReducer },
});

// If the API says the session is over, log out in the UI.
setUnauthorizedHandler(() => store.dispatch(sessionExpired()));

// Remember which project was open.
let lastActive = store.getState().tasks.activeProjectId;
store.subscribe(() => {
  const id = store.getState().tasks.activeProjectId;
  if (id !== lastActive) { lastActive = id; saveActiveProject(id); }
});
