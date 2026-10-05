const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const MAX_RECENT = 6;
 
/* ===== Helpers ===== */
const $ = (selector) => document.querySelector(selector);
 
const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
 
const state = {
  unit: storage.get("unit", "C"),
  current: null,
  forecast: null,
  recent: storage.get("recent", []),
};
 
const el = {
  form: $("#search-form"), input: $("#city-input"), searchBtn: $("#search-btn"), locationBtn: $("#location-btn"),
  error: $("#error"), loader: $("#loader"), empty: $("#empty"), weather: $("#weather"),
  unitToggle: $("#unit-toggle"), themeToggle: $("#theme-toggle"), fx: $("#fx"),
};
 
const isF = () => state.unit === "F";
const temp = (c) => `${Math.round(isF() ? (c * 9) / 5 + 32 : c)}°`;
const wind = (ms) => (isF() ? `${Math.round(ms * 2.237)} mph` : `${Math.round(ms * 3.6)} km/h`);
 
/** Format a UNIX timestamp in the searched city's local time (tz = offset in seconds). */
const cityTime = (ts, tz, options) =>
  new Date((ts + tz) * 1000).toLocaleString("en-US", { timeZone: "UTC", ...options });
 
function weatherGroup(id) {
  if (id >= 200 && id < 300) return "storm";
  if (id >= 300 && id < 600) return "rain";
  if (id >= 600 && id < 700) return "snow";
  if (id >= 700 && id < 800) return "mist";
  return id === 800 ? "clear" : "clouds";
}
 
/* ===== API ===== */
async function request(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("Network error. Check your internet connection and try again.");
  }
  if (!response.ok) throw new Error("The weather service is unavailable. Please try later.");
  return response.json();
}

function weatherInfo(code, isDay = true) {
  const conditions = {
    0: [800, "Clear", "clear sky", "01"],
    1: [801, "Clouds", "mainly clear", "02"],
    2: [802, "Clouds", "partly cloudy", "03"],
    3: [804, "Clouds", "overcast", "04"],
    45: [741, "Mist", "fog", "50"],
    48: [741, "Mist", "depositing rime fog", "50"],
    51: [300, "Drizzle", "light drizzle", "09"],
    53: [301, "Drizzle", "moderate drizzle", "09"],
    55: [302, "Drizzle", "dense drizzle", "09"],
    56: [511, "Rain", "light freezing drizzle", "13"],
    57: [511, "Rain", "dense freezing drizzle", "13"],
    61: [500, "Rain", "light rain", "10"],
    63: [501, "Rain", "moderate rain", "10"],
    65: [502, "Rain", "heavy rain", "10"],
    66: [511, "Rain", "light freezing rain", "13"],
    67: [511, "Rain", "heavy freezing rain", "13"],
    71: [600, "Snow", "light snow", "13"],
    73: [601, "Snow", "moderate snow", "13"],
    75: [602, "Snow", "heavy snow", "13"],
    77: [601, "Snow", "snow grains", "13"],
    80: [520, "Rain", "light rain showers", "09"],
    81: [521, "Rain", "moderate rain showers", "09"],
    82: [522, "Rain", "violent rain showers", "09"],
    85: [600, "Snow", "light snow showers", "13"],
    86: [602, "Snow", "heavy snow showers", "13"],
    95: [200, "Thunderstorm", "thunderstorm", "11"],
    96: [201, "Thunderstorm", "thunderstorm with light hail", "11"],
    99: [202, "Thunderstorm", "thunderstorm with heavy hail", "11"],
  };
  const [id, main, description, icon] = conditions[code] || [801, "Clouds", "unknown conditions", "02"];
  return { id, main, description, icon: `${icon}${isDay ? "d" : "n"}` };
}

function localTimeToUnix(value, offset) {
  return Date.parse(`${value}Z`) / 1000 - offset;
}

function toWeatherState(location, data) {
  const { current: now, daily, hourly, utc_offset_seconds: offset } = data;
  const currentTime = localTimeToUnix(now.time, offset);
  const currentWallTime = Date.parse(`${now.time}Z`);
  const hourlyIndex = hourly.time.reduce((closest, time, index) =>
    Math.abs(Date.parse(`${time}Z`) - currentWallTime) < Math.abs(Date.parse(`${hourly.time[closest]}Z`) - currentWallTime)
      ? index
      : closest, 0);
  const condition = weatherInfo(now.weather_code, now.is_day === 1);
  return {
    current: {
      name: location.name,
      sys: {
        country: location.country || "",
        sunrise: localTimeToUnix(daily.sunrise[0], offset),
        sunset: localTimeToUnix(daily.sunset[0], offset),
      },
      timezone: offset,
      dt: currentTime,
      weather: [condition],
      main: {
        temp: now.temperature_2m,
        feels_like: now.apparent_temperature,
        humidity: now.relative_humidity_2m,
        pressure: now.surface_pressure,
      },
      wind: { speed: now.wind_speed_10m },
      visibility: hourly.visibility[hourlyIndex] ?? 0,
    },
    forecast: daily.time.map((date, index) => ({
      date,
      condition: weatherInfo(daily.weather_code[index]),
      temp: (daily.temperature_2m_max[index] + daily.temperature_2m_min[index]) / 2,
      min: daily.temperature_2m_min[index],
      max: daily.temperature_2m_max[index],
    })),
  };
}

async function loadWeather(location) {
  setLoading(true);
  hideError();
  try {
    if (typeof location === "string") {
      const places = await request(`${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`);
      const place = places.results?.[0];
      if (!place) throw new Error("City not found. Check the spelling and try again.");
      location = { latitude: place.latitude, longitude: place.longitude, name: place.name, country: place.country_code };
    }
    const params = new URLSearchParams({
      latitude: location.latitude,
      longitude: location.longitude,
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,surface_pressure,wind_speed_10m",
      hourly: "visibility",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
      timezone: "auto",
      forecast_days: "5",
      wind_speed_unit: "ms",
    });
    const data = await request(`${WEATHER_URL}?${params}`);
    const { current, forecast } = toWeatherState(location, data);
    Object.assign(state, { current, forecast });
    storage.set("lastCity", current.name);
    addRecent(current.name);
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

const searchCity = (city) => loadWeather(city);

function useMyLocation() {
  if (!navigator.geolocation) return showError("Geolocation isn't supported by your browser. Search for a city instead.");
  setLoading(true);
  hideError();
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => loadWeather({
      latitude: coords.latitude,
      longitude: coords.longitude,
      name: "Your location",
      country: "",
    }),
    (error) => {
      setLoading(false);
      showError(error.code === error.PERMISSION_DENIED
        ? "Location access was denied. Allow it in your browser settings or search for a city."
        : "Couldn't determine your location. Try searching for a city.");
    },
    { timeout: 10000 }
  );
}
 
/* ===== UI state ===== */
function setLoading(isLoading) {
  el.loader.hidden = !isLoading;
  [el.input, el.searchBtn, el.locationBtn, ...document.querySelectorAll("#recent-list button")]
    .forEach((control) => (control.disabled = isLoading));
}
function showError(message) { el.error.textContent = message; el.error.hidden = false; }
function hideError() { el.error.hidden = true; }
 
/* ===== Rendering ===== */
function render() {
  const { current: c, forecast: f } = state;
  if (!c) return;
  const tz = c.timezone;
  const [condition] = c.weather;
  const isNight = c.dt < c.sys.sunrise || c.dt > c.sys.sunset;
  const group = weatherGroup(condition.id);
 
  document.body.dataset.weather = group;
  document.body.dataset.time = isNight ? "night" : "day";
  buildEffects(group);
 
  $("#city").textContent = c.name;
  $("#country").textContent = c.sys.country || "";
  $("#temp").textContent = temp(c.main.temp);
  $("#condition").textContent = condition.description;
  $("#feels").textContent = `Feels like ${temp(c.main.feels_like)}`;
  const icon = $("#icon");
  icon.src = `https://openweathermap.org/img/wn/${condition.icon}@4x.png`;
  icon.alt = condition.main;
 
  const time = (ts) => cityTime(ts, tz, { hour: "numeric", minute: "2-digit" });
  const details = [
    ["💧", "Humidity", `${c.main.humidity}%`],
    ["🌬️", "Wind", wind(c.wind.speed)],
    ["🧭", "Pressure", `${c.main.pressure} hPa`],
    ["👁️", "Visibility", `${(c.visibility / 1000).toFixed(1)} km`],
    ["🌅", "Sunrise", time(c.sys.sunrise)],
    ["🌇", "Sunset", time(c.sys.sunset)],
  ];
  $("#details").innerHTML = details
    .map(([icon, label, value]) => `<div class="detail"><span>${icon} ${label}</span><strong>${value}</strong></div>`)
    .join("");
 
  $("#forecast").innerHTML = f
    .map((d) => `
      <article class="card day">
        <h3>${new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}</h3>
        <p class="date">${new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</p>
        <img src="https://openweathermap.org/img/wn/${d.condition.icon}@2x.png" alt="${d.condition.description}" width="72" height="72">
        <p class="t">${temp(d.temp)}</p><p class="c">${d.condition.description}</p>
        <p class="range">↓ ${temp(d.min)} · ↑ ${temp(d.max)}</p>
      </article>`)
    .join("");
 
  el.empty.hidden = true;
  el.weather.hidden = false;
  el.weather.classList.remove("animate");
  void el.weather.offsetWidth; // restart entrance animation
  el.weather.classList.add("animate");
  updateClock();
  renderRecent();
}
 
/* ===== Weather effects ===== */
function buildEffects(group) {
  const type = group === "rain" || group === "storm" ? "drop" : group === "snow" ? "flake" : null;
  el.fx.innerHTML = "";
  if (!type) return;
  const count = type === "drop" ? 70 : 45;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.className = type;
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = type === "drop" ? `${0.6 + Math.random() * 0.6}s` : `${5 + Math.random() * 6}s, ${2 + Math.random() * 3}s`;
    p.style.animationDelay = `${-Math.random() * 6}s`;
    fragment.appendChild(p);
  }
  el.fx.appendChild(fragment);
}
 
/* ===== Recent searches ===== */
function addRecent(city) {
  state.recent = [city, ...state.recent.filter((c) => c.toLowerCase() !== city.toLowerCase())].slice(0, MAX_RECENT);
  storage.set("recent", state.recent);
}
 
function renderRecent() {
  const list = $("#recent-list");
  list.innerHTML = "";
  state.recent.forEach((city) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = city;
    button.addEventListener("click", () => searchCity(city));
    item.appendChild(button);
    list.appendChild(item);
  });
  $("#recent-empty").hidden = state.recent.length > 0;
  $("#clear-recent").hidden = state.recent.length === 0;
}
 
/* ===== Date & time ===== */
function updateClock() {
  const now = Date.now() / 1000;
  const options = { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  $("#datetime").textContent = state.current
    ? `${cityTime(now, state.current.timezone, options)} (local time)`
    : new Date().toLocaleString("en-US", options);
}
 
/* ===== Theme & units ===== */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
  el.themeToggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
}
 
function applyUnit() {
  el.unitToggle.textContent = isF() ? "°F" : "°C";
  el.unitToggle.setAttribute("aria-pressed", isF());
  el.unitToggle.setAttribute("aria-label", `Switch to ${isF() ? "Celsius" : "Fahrenheit"}`);
}
 
/* ===== Events ===== */
el.form.addEventListener("submit", (event) => {
  event.preventDefault(); // handles both the Search button and Enter key
  const city = el.input.value.trim();
  if (!city) return showError("Please enter a city name.");
  searchCity(city);
});
 
el.locationBtn.addEventListener("click", useMyLocation);
 
el.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  storage.set("theme", next);
});
 
el.unitToggle.addEventListener("click", () => {
  state.unit = isF() ? "C" : "F";
  storage.set("unit", state.unit);
  applyUnit();
  render(); // re-render from cached data, no refetch
});
 
$("#clear-recent").addEventListener("click", () => {
  state.recent = [];
  storage.set("recent", []);
  renderRecent();
});
 
/* ===== Init ===== */
applyTheme(storage.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
applyUnit();
renderRecent();
updateClock();
setInterval(updateClock, 30000);
 
const lastCity = storage.get("lastCity", "");
if (lastCity) {
  el.input.value = lastCity;
  searchCity(lastCity);
}