import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWeather } from '../store/weatherSlice.js';

// 7-day forecast from the third-party Open-Meteo API (through our server).
export default function WeatherCard() {
  const dispatch = useDispatch();
  const { city, place, days, status, error } = useSelector((s) => s.weather);
  const [input, setInput] = useState(city);

  const submit = (e) => {
    e.preventDefault();
    dispatch(fetchWeather(input.trim()));
  };

  return (
    <aside className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="font-display text-base font-bold">Weather{place ? `: ${place}` : ''}</h2>
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input className="field" placeholder="City" aria-label="City" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn-ghost" type="submit">Go</button>
      </form>
      {status === 'loading' && <p className="mt-2 text-sm text-steel">Loading...</p>}
      {status === 'failed' && <p role="alert" className="mt-2 text-sm text-alert">{error}</p>}
      <ul className="mt-2 space-y-1.5">
        {days.slice(0, 5).map((d) => (
          <li key={d.date} className="flex justify-between gap-2 text-sm">
            <span>
              {new Date(`${d.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
              <span className="text-steel"> &middot; {d.summary}</span>
            </span>
            <span className="shrink-0 text-xs text-steel">{d.min}&deg;/{d.max}&deg;C</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-steel">Plan deadlines around the weather. Data: Open-Meteo</p>
    </aside>
  );
}
