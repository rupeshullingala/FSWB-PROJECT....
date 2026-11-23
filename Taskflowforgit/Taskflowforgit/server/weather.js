/**
 * Third-party API: Open-Meteo (https://open-meteo.com), free, no API key, works for any city in the world.
 *  1. geocoding-api.open-meteo.com turns a city name into coordinates
 *  2. api.open-meteo.com returns the 7-day forecast for those coordinates
 * The server calls it and caches the answers, so the browser never talks to the third party directly.
 */
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEO_TTL = 24 * 3600 * 1000;
const FORECAST_TTL = 30 * 60 * 1000;
const geoCache = new Map(); // "hyderabad" -> { at, place }
const forecastCache = new Map(); // "17.38,78.48" -> { at, days }

// WMO weather codes used by Open-Meteo, grouped into short labels.
const label = (code) => {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 95) return 'Thunderstorm';
  return 'Mixed';
};

export class CityNotFound extends Error {}

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const text = await res.text();
  if (!text) throw new Error('Open-Meteo sent an empty response');
  return JSON.parse(text);
};

async function findPlace(city) {
  const key = city.toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.place;
  const data = await getJson(`${GEO}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
  const r = data.results?.[0];
  if (!r) throw new CityNotFound(`Could not find a city called "${city}"`);
  const place = { name: r.name, country: r.country ?? '', latitude: r.latitude, longitude: r.longitude };
  geoCache.set(key, { at: Date.now(), place });
  return place;
}

export async function getWeather(city) {
  const place = await findPlace(city);
  const key = `${place.latitude},${place.longitude}`;
  let hit = forecastCache.get(key);
  if (!hit || Date.now() - hit.at >= FORECAST_TTL) {
    const data = await getJson(
      `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7');
    const d = data.daily;
    if (!d?.time) throw new Error('Unexpected response from Open-Meteo');
    const days = d.time.map((date, i) => ({
      date,
      summary: label(d.weather_code[i]),
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
      rainChance: d.precipitation_probability_max?.[i] ?? 0,
    }));
    hit = { at: Date.now(), days };
    forecastCache.set(key, hit);
  }
  return { city: place.name, country: place.country, days: hit.days };
}
