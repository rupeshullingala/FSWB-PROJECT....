import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { api } from '../api.js';
import { logout, sessionExpired } from './authSlice.js';

// Third-party data (Open-Meteo weather) comes through our own server: GET /api/weather?city=...
const CITY_KEY = 'taskflow-city';
const readCity = () => { try { return localStorage.getItem(CITY_KEY) || ''; } catch { return ''; } };

// An empty city makes the server use its default (WEATHER_CITY, or Hyderabad).
export const fetchWeather = createAsyncThunk('weather/fetch', (city) => {
  try { if (city) localStorage.setItem(CITY_KEY, city); } catch { /* ignore */ }
  return api(`/weather?city=${encodeURIComponent(city ?? '')}`);
});

const initial = { city: readCity(), place: '', days: [], status: 'idle', error: '' }; // status: idle | loading | ready | failed

const slice = createSlice({
  name: 'weather',
  initialState: initial,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchWeather.pending, (state) => { state.status = 'loading'; state.error = ''; })
      .addCase(fetchWeather.fulfilled, (state, { payload }) => {
        state.status = 'ready';
        state.place = payload.city;
        state.city = payload.city;
        state.days = payload.days;
      })
      .addCase(fetchWeather.rejected, (state, { error }) => { state.status = 'failed'; state.error = error.message; })
      .addCase(logout.fulfilled, () => ({ ...initial, city: '' }))
      .addCase(sessionExpired, () => ({ ...initial, city: '' }));
  },
});

export const selectForecastByDate = (state, date) => state.weather.days.find((d) => d.date === date);

export default slice.reducer;
