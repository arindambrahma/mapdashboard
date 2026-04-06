// ============================================================
// Gothenburg Transit Dashboard - Frontend
// ============================================================

const GOTHENBURG_CENTER = [57.7089, 11.9746];
const GOTHENBURG_BOUNDS = {
  lowerLeftLat: 57.58,
  lowerLeftLong: 11.80,
  upperRightLat: 57.82,
  upperRightLong: 12.15,
};
const POLL_INTERVAL  = 5000;   // vehicle position poll (ms)
const ANIM_DURATION  = 4800;   // smooth move duration — just under poll interval
const WEATHER_REFRESH = 600000;
const DEPARTURE_IFRAME_BASE = 'https://avgangstavla.vasttrafik.se/?source=vasttrafikse&stopAreaGid=';
const DISTURBANCE_POLL = 120000; // 2 minutes

// Static tram line definitions — always shown regardless of live service.
const STATIC_TRAM_LINES = [
  { name: '1',  route: 'Östra Sjukhuset \u2013 Tynnered',        bg: '#ffffff', fg: '#006c93' },
  { name: '2',  route: 'Järntorget \u2013 Mölndal',              bg: '#ffdd00', fg: '#006c93' },
  { name: '3',  route: 'Vagnhallen Majorna \u2013 Kålltorp',     bg: '#0071c1', fg: '#ffffff' },
  { name: '4',  route: 'Mölndal \u2013 Angered',                 bg: '#027446', fg: '#ffffff' },
  { name: '5',  route: 'Torp \u2013 Östra Sjukhuset',            bg: '#c63539', fg: '#ffffff' },
  { name: '6',  route: 'Frihamnen \u2013 Kortedala',             bg: '#f89828', fg: '#00435c' },
  { name: '7',  route: 'Tynnered \u2013 Bergsjön',               bg: '#764712', fg: '#ffffff' },
  { name: '8',  route: 'Frölunda \u2013 Hjällbo',                bg: '#8b2fc9', fg: '#ffffff' },
  { name: '9',  route: 'Kungssten \u2013 Angered centrum',       bg: '#9b9b9b', fg: '#ffffff' },
  { name: '10', route: 'Guldheden \u2013 Lindholmen',            bg: '#d8e8b0', fg: '#006c93' },
  { name: '11', route: 'Saltholmen \u2013 Bergsjön',             bg: '#000000', fg: '#ffffff' },
  { name: '12', route: 'Lindholmen \u2013 Mölndal',              bg: '#00adef', fg: '#ffffff' },
  { name: '13', route: 'Sahlgrenska \u2013 Angered centrum',     bg: '#e87722', fg: '#ffffff' },
  { name: 'X',  route: 'Frihamnen \u2013 Kortedala (express)',   bg: '#ffffff', fg: '#c63539' },
];

const WEATHER_CODES = {
  0:  ['\u2600\ufe0f', 'Clear sky'],        1:  ['\ud83c\udf24\ufe0f', 'Mainly clear'],
  2:  ['\u26c5', 'Partly cloudy'],           3:  ['\u2601\ufe0f', 'Overcast'],
  45: ['\ud83c\udf2b\ufe0f', 'Fog'],         48: ['\ud83c\udf2b\ufe0f', 'Freezing fog'],
  51: ['\ud83c\udf26\ufe0f', 'Light drizzle'], 53: ['\ud83c\udf26\ufe0f', 'Drizzle'],
  55: ['\ud83c\udf27\ufe0f', 'Dense drizzle'], 61: ['\ud83c\udf27\ufe0f', 'Light rain'],
  63: ['\ud83c\udf27\ufe0f', 'Moderate rain'], 65: ['\ud83c\udf27\ufe0f', 'Heavy rain'],
  71: ['\ud83c\udf28\ufe0f', 'Light snow'],   73: ['\ud83c\udf28\ufe0f', 'Moderate snow'],
  75: ['\u2744\ufe0f', 'Heavy snow'],         80: ['\ud83c\udf26\ufe0f', 'Light showers'],
  81: ['\ud83c\udf27\ufe0f', 'Showers'],      82: ['\u26c8\ufe0f', 'Heavy showers'],
  95: ['\u26c8\ufe0f', 'Thunderstorm'],       96: ['\u26c8\ufe0f', 'Thunderstorm+hail'],
  99: ['\u26c8\ufe0f', 'Thunderstorm+hail'],
};

const MODE_LABELS = { tram: 'Tram Line', bus: 'Bus Line', ferry: 'Ferry Line' };

// --- Map Setup ---
const INNER_CITY_BOUNDS = L.latLngBounds(
  [57.682908, 11.941495],  // SW
  [57.703597, 11.973166]   // NE
);

const map = L.map('map', { zoomControl: false });
map.fitBounds(INNER_CITY_BOUNDS);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19,
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

// --- State ---
let currentMode      = 'tram';
let availableLines   = {};           // { name: { bg, fg, routeDesc, directions, refs, active } }
let selectedLines    = new Set(['1', '6']); // multi-select; empty = show all
let selectedDirs     = {};           // { lineName: dirString | null }
let vehicleMarkers   = {};           // { id: L.Marker }
let markerAnims      = {};           // { id: { fromLat, fromLng, toLat, toLng, startTime } }
let animFrameId      = null;
let routeLayers      = {};           // { lineName: L.LayerGroup }
let routeStopMarkers = {};           // { lineName: [L.Marker, ...] }
let refreshCountdown = POLL_INTERVAL / 1000;
let activeStopGid    = '9021014005140000'; // default: Olivedalsgatan

// --- DOM ---
const lineListEl    = document.getElementById('line-list');
const departureFrame = document.getElementById('departureFrame');
const refreshTimerEl = document.getElementById('refreshTimer');
const headerLabel   = document.querySelector('.line-table-header span:first-child');

// ============================================================
// Transport Type Switching
// ============================================================

document.querySelectorAll('input[name="transportType"]').forEach(radio => {
  radio.addEventListener('change', e => {
    currentMode = e.target.value;
    selectedLines = new Set();
    selectedDirs  = {};
    availableLines = {};
    clearAllRoutes();
    clearVehicleMarkers();
    headerLabel.textContent = MODE_LABELS[currentMode] || 'Line';
    lineListEl.innerHTML = '<div class="line-loading">Loading lines...</div>';
    fetchVehiclePositions();
  });
});

// ============================================================
// Line Table
// ============================================================

function buildLineTable() {
  let entries;
  if (currentMode === 'tram') {
    entries = STATIC_TRAM_LINES.map(def => {
      const live = availableLines[def.name];
      return [def.name, {
        bg:        live?.bg        || def.bg,
        fg:        live?.fg        || def.fg,
        routeDesc: live?.routeDesc || def.route,
        directions: live?.directions || new Set(),
        refs:      live?.refs      || [],
        active:    !!live,
      }];
    });
  } else {
    entries = Object.entries(availableLines)
      .map(([n, i]) => [n, { ...i, active: true }])
      .sort((a, b) => {
        const na = parseInt(a[0]), nb = parseInt(b[0]);
        return (!isNaN(na) && !isNaN(nb)) ? na - nb : a[0].localeCompare(b[0]);
      });
  }

  if (entries.length === 0) {
    lineListEl.innerHTML = '<div class="line-loading">No active lines</div>';
    return;
  }

  lineListEl.innerHTML = entries.map(([name, info]) => {
    const isSelected = selectedLines.has(name);
    const dirs = [...info.directions];
    const currentDir = selectedDirs[name] || 'All';
    const dirOptions = dirs.map(d =>
      `<option value="${d}" ${currentDir === d ? 'selected' : ''}>${d}</option>`
    ).join('');

    const badgeStyle = `background:${info.bg};color:${info.fg}${info.active ? '' : ';opacity:0.4'}`;

    return `
      <div class="line-row ${isSelected ? 'selected' : ''} ${info.active ? '' : 'inactive'}" data-line="${name}">
        <div class="line-badge" style="${badgeStyle}">${name}</div>
        <div class="line-route">${info.routeDesc || dirs.join(' \u2013 ') || '\u2014'}</div>
        <div class="line-direction">
          ${info.active
            ? `<select data-line-dir="${name}">
                <option value="All">All Directions</option>
                ${dirOptions}
               </select>`
            : `<span class="no-service">No service</span>`}
        </div>
      </div>`;
  }).join('');
}

// Click row: toggle selection + fetch/clear route
lineListEl.addEventListener('click', e => {
  const row = e.target.closest('.line-row');
  if (!row || e.target.closest('.line-direction') || row.classList.contains('inactive')) return;

  const name = row.dataset.line;
  if (selectedLines.has(name)) {
    selectedLines.delete(name);
    clearRouteForLine(name);
  } else {
    selectedLines.add(name);
    fetchRouteForLine(name);
  }
  buildLineTable();
  fetchVehiclePositions();
});

// Direction dropdown
lineListEl.addEventListener('change', e => {
  const select = e.target.closest('select[data-line-dir]');
  if (!select) return;
  const name = select.dataset.lineDir;
  selectedDirs[name] = select.value === 'All' ? null : select.value;
  if (selectedLines.has(name)) fetchRouteForLine(name);
  fetchVehiclePositions();
});

// ============================================================
// Smooth Vehicle Animation (requestAnimationFrame)
// ============================================================

function animationLoop(ts) {
  let stillRunning = false;
  for (const [id, anim] of Object.entries(markerAnims)) {
    if (!vehicleMarkers[id]) { delete markerAnims[id]; continue; }
    const t = Math.min((ts - anim.startTime) / ANIM_DURATION, 1);
    const lat = anim.fromLat + (anim.toLat - anim.fromLat) * t;
    const lng = anim.fromLng + (anim.toLng - anim.fromLng) * t;
    vehicleMarkers[id].setLatLng([lat, lng]);
    if (t < 1) stillRunning = true;
    else delete markerAnims[id];
  }
  animFrameId = stillRunning ? requestAnimationFrame(animationLoop) : null;
}

function animateMarkerTo(id, toLat, toLng) {
  const marker = vehicleMarkers[id];
  if (!marker) return;
  const { lat: fromLat, lng: fromLng } = marker.getLatLng();
  markerAnims[id] = { fromLat, fromLng, toLat, toLng, startTime: performance.now() };
  if (!animFrameId) animFrameId = requestAnimationFrame(animationLoop);
}

// ============================================================
// Vehicle Positions
// ============================================================

function createVehicleIcon(line, bg, fg) {
  const size = line.length > 2 ? 30 : 26;
  return L.divIcon({
    className: '',
    html: `<div class="vehicle-marker" style="width:${size}px;height:${size}px;background:${bg || '#00b4d8'};color:${fg || '#fff'}">${line}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

async function fetchVehiclePositions() {
  const params = new URLSearchParams({
    lowerLeftLat:  GOTHENBURG_BOUNDS.lowerLeftLat,
    lowerLeftLong: GOTHENBURG_BOUNDS.lowerLeftLong,
    upperRightLat:  GOTHENBURG_BOUNDS.upperRightLat,
    upperRightLong: GOTHENBURG_BOUNDS.upperRightLong,
    limit: '200',
  });

  if (currentMode === 'tram') {
    // Always fetch all tram lines so the full list stays up-to-date.
    // selectedLines filtering happens in updateVehicleMarkers, not here.
    STATIC_TRAM_LINES.forEach(l => params.append('lineDesignations', l.name));
  }

  try {
    const res = await fetch(`/api/vt/positions?${params}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const vehicles = await res.json();
    const filtered = (Array.isArray(vehicles) ? vehicles : [])
      .filter(v => v.line && v.line.transportMode === currentMode);
    processVehicles(filtered);
  } catch (err) {
    console.error('Failed to fetch positions:', err);
  }
}

function processVehicles(vehicles) {
  vehicles.forEach(v => {
    const name = v.line.name;
    if (!availableLines[name]) {
      availableLines[name] = {
        gid:  v.line.gid || null,
        bg:   v.line.backgroundColor  || '#666',
        fg:   v.line.foregroundColor  || '#fff',
        directions: new Set(),
        refs: [],
      };
    }
    const shortDir = v.directionDetails?.shortDirection || v.direction || '';
    if (shortDir) availableLines[name].directions.add(shortDir);

    if (v.detailsReference && availableLines[name].refs.length < 2) {
      const existing = availableLines[name].refs.map(r => r.dir);
      if (!existing.includes(shortDir)) availableLines[name].refs.push({ ref: v.detailsReference, dir: shortDir });
    }
  });

  Object.values(availableLines).forEach(info => {
    if (info.directions.size >= 2) info.routeDesc = [...info.directions].join(' \u2013 ');
  });

  buildLineTable();
  updateVehicleMarkers(vehicles);
}

function updateVehicleMarkers(vehicles) {
  const activeIds = new Set();

  vehicles.forEach(v => {
    if (!v.line?.name) return;
    const line    = v.line.name;
    const toLat   = v.latitude;
    const toLng   = v.longitude;
    if (!toLat || !toLng) return;

    // Only show on map if in the selected set (or nothing selected = show all)
    if (selectedLines.size > 0 && !selectedLines.has(line)) return;

    // Direction filter (per line)
    const shortDir = v.directionDetails?.shortDirection || v.direction || '';
    const dirFilter = selectedDirs[line];
    if (dirFilter && shortDir !== dirFilter) return;

    const id = v.detailsReference || `${line}-${toLat}-${toLng}`;
    activeIds.add(id);

    const popup = `<div class="vehicle-popup"><strong>Line ${line}</strong><br>Direction: ${shortDir || 'N/A'}</div>`;

    if (vehicleMarkers[id]) {
      // Smoothly animate to new position
      animateMarkerTo(id, toLat, toLng);
      vehicleMarkers[id].setPopupContent(popup);
    } else {
      vehicleMarkers[id] = L.marker([toLat, toLng], {
        icon: createVehicleIcon(line, v.line.backgroundColor, v.line.foregroundColor),
      }).bindPopup(popup).addTo(map);
    }
  });

  // Remove markers that didn't appear in this update
  Object.keys(vehicleMarkers).forEach(id => {
    if (!activeIds.has(id)) {
      delete markerAnims[id];
      map.removeLayer(vehicleMarkers[id]);
      delete vehicleMarkers[id];
    }
  });
}

function clearVehicleMarkers() {
  Object.keys(markerAnims).forEach(id => delete markerAnims[id]);
  Object.values(vehicleMarkers).forEach(m => map.removeLayer(m));
  vehicleMarkers = {};
}

// ============================================================
// Route Display — per-line, supports multiple simultaneous routes
// ============================================================

function clearRouteForLine(name) {
  if (routeLayers[name]) { map.removeLayer(routeLayers[name]); delete routeLayers[name]; }
  (routeStopMarkers[name] || []).forEach(m => map.removeLayer(m));
  delete routeStopMarkers[name];
}

function clearAllRoutes() {
  Object.keys(routeLayers).forEach(clearRouteForLine);
}


async function fetchRouteForLine(name) {
  clearRouteForLine(name);   // clear stale route first
  const info = availableLines[name];
  if (!info || info.refs.length === 0) return;

  const dir = selectedDirs[name];
  const refObj = dir ? info.refs.find(r => r.dir === dir) : null;
  const ref = refObj?.ref || info.refs[0].ref;

  try {
    const res = await fetch(`/api/route/${encodeURIComponent(ref)}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { stops, geometry } = await res.json();
    if (!stops || stops.length === 0) return;

    const lineColor = (info.bg === '#ffffff' || info.bg === '#ffff50') ? info.fg : info.bg;
    const layers = [];

    geometry.forEach(seg => {
      if (seg?.length) layers.push(L.polyline(seg, { color: lineColor, weight: 5, opacity: 0.5 }));
    });
    for (let i = 0; i < stops.length - 1; i++) {
      if (!geometry[i]) {
        layers.push(L.polyline(
          [[stops[i].lat, stops[i].lng], [stops[i+1].lat, stops[i+1].lng]],
          { color: lineColor, weight: 4, opacity: 0.25, dashArray: '6, 8' }
        ));
      }
    }

    routeLayers[name] = L.layerGroup(layers).addTo(map);

    const stopIcon = L.divIcon({
      className: '', html: '<div class="stop-marker"></div>', iconSize: [10,10], iconAnchor: [5,5],
    });
    routeStopMarkers[name] = stops.map(s => {
      const label = s.name.replace(/, G\u00f6teborg$/, '');
      return L.marker([s.lat, s.lng], { icon: stopIcon })
        .bindPopup(`<div class="stop-popup">${label}</div>`)
        .addTo(map);
    });

  } catch (err) {
    console.error('Failed to fetch route for', name, err);
  }
}

// ============================================================
// Stop Buttons & Departure Board
// ============================================================

document.getElementById('stop-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.stop-btn');
  if (!btn) return;
  document.querySelectorAll('.stop-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  departureFrame.src = DEPARTURE_IFRAME_BASE + btn.dataset.gid;
  activeStopGid = btn.dataset.gid;
  fetchDisturbances();
});

// ============================================================
// Weather Widget (enhanced — current + 8-hour hourly forecast)
// ============================================================

function findCurrentHourIdx(times) {
  // times[] are Stockholm local time strings like "2024-01-15T14:00"
  // Compare against the current Stockholm time rendered as the same format.
  const nowStr = new Date().toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).replace(',', ''); // "2024-01-15 14" (sv-SE uses space, not T)
  const idx = times.findIndex(t => t.replace('T', ' ').slice(0, 13) === nowStr);
  return idx >= 0 ? idx : 0;
}

async function fetchWeather() {
  try {
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=57.7089&longitude=11.9746' +
      '&current=temperature_2m,weather_code,precipitation_probability,wind_speed_10m,apparent_temperature' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,precipitation' +
      '&timezone=Europe%2FStockholm&forecast_days=2'
    );
    const data = await res.json();
    renderWeather(data);
  } catch (err) {
    document.getElementById('weather-desc').textContent = 'Weather unavailable';
  }
}

function renderWeather(data) {
  const c = data.current;
  const [emoji, desc] = WEATHER_CODES[c.weather_code] || ['\ud83c\udf21\ufe0f', 'Unknown'];

  document.getElementById('weather-icon').textContent = emoji;
  document.getElementById('weather-temp').textContent = `${Math.round(c.temperature_2m)}\u00b0C`;
  document.getElementById('weather-feels').textContent = `Feels ${Math.round(c.apparent_temperature)}\u00b0C`;
  document.getElementById('weather-desc').textContent = desc;
  document.getElementById('weather-wind').textContent = `\ud83d\udca8 ${Math.round(c.wind_speed_10m)} km/h`;
  document.getElementById('weather-rain').textContent =
    c.precipitation_probability != null ? `\ud83c\udf27 ${c.precipitation_probability}%` : '';

  // --- Hourly forecast strip (next 9 hours including current) ---
  const times  = data.hourly.time;
  const probs  = data.hourly.precipitation_probability;
  const codes  = data.hourly.weather_code;
  const startI = findCurrentHourIdx(times);

  const hours = [];
  for (let i = startI; i < Math.min(startI + 9, times.length); i++) {
    hours.push({
      label:  times[i].slice(11, 16),  // "14:00"
      prob:   probs[i] ?? 0,
      emoji:  (WEATHER_CODES[codes[i]] || ['\ud83c\udf21\ufe0f'])[0],
    });
  }

  // Find next rain event for summary label
  const nextRain = hours.slice(1).find(h => h.prob >= 40);
  const rainSummary = nextRain
    ? `Rain possible around ${nextRain.label}`
    : hours[0].prob >= 40 ? 'Rain likely now' : 'No rain expected soon';

  const forecastEl = document.getElementById('weather-forecast');
  const hourCols = hours.map(h => {
    const color = h.prob >= 70 ? '#00b4d8' : h.prob >= 40 ? '#78909c' : '#37474f';
    const barH  = Math.max(2, Math.round(h.prob * 0.22)); // 0–22px
    return `
      <div class="forecast-hour">
        <div class="forecast-time">${h.label.slice(0, 2)}</div>
        <div class="forecast-emoji">${h.emoji}</div>
        <div class="forecast-bar" style="height:${barH}px;background:${color}"></div>
        <div class="forecast-prob" style="color:${color}">${h.prob}%</div>
      </div>`;
  }).join('');
  forecastEl.innerHTML =
    `<div class="forecast-summary">${rainSummary}</div>` +
    `<div class="forecast-hours">${hourCols}</div>`;
}

// ============================================================
// Traffic Disturbances (Störning v1)
// ============================================================

function extractSituations(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw?.trafficSituations) return raw.trafficSituations;
  if (raw?.results) return raw.results;
  return [];
}

function situationText(s) {
  if (s.description && typeof s.description === 'string') return s.description;
  if (Array.isArray(s.descriptions)) {
    const pick = s.descriptions.find(d => d.language === 'en')
               || s.descriptions.find(d => d.language === 'sv')
               || s.descriptions[0];
    if (pick?.text) return pick.text;
  }
  return s.title || s.headline || 'Traffic disturbance';
}

function severityColor(sev) {
  const s = (sev || '').toLowerCase();
  if (s === 'veryhigh' || s === 'severe' || s === 'serious') return '#e63946';
  if (s === 'high' || s === 'moderate' || s === 'medium')    return '#f4a261';
  return '#78909c';
}

async function fetchDisturbances() {
  if (!activeStopGid) return;

  try {
    const raw = await fetch(`/api/disturbances/stop/${encodeURIComponent(activeStopGid)}`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

    const situMap = new Map();
    extractSituations(raw).forEach(s => {
      const key = s.situationNumber || s.id || situationText(s);
      if (!situMap.has(key)) situMap.set(key, s);
    });

    renderDisturbances([...situMap.values()]);
  } catch (err) {
    console.error('Disturbance fetch error:', err);
  }
}

function renderDisturbances(situations) {
  const overlay  = document.getElementById('disturbance-overlay');
  const list     = document.getElementById('disturbance-list');
  const countEl  = document.getElementById('disturbance-count');

  // Filter out situations that have already ended
  const now    = Date.now();
  const active = situations.filter(s => !s.endTime || new Date(s.endTime).getTime() > now);

  if (active.length === 0) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'flex';
  countEl.textContent   = `${active.length} alert${active.length !== 1 ? 's' : ''}`;

  list.innerHTML = active.map(s => {
    const color = severityColor(s.severity);

    // Use the dedicated title field; fall back to first sentence of description
    const title = s.title || situationText(s).slice(0, 80);

    // Description body — omit if it's identical to the title
    const desc  = (s.description && s.description !== s.title) ? s.description : '';
    const descTrunc = desc.length > 200 ? desc.slice(0, 200) + '\u2026' : desc;

    const start = s.startTime ? new Date(s.startTime) : null;
    const end   = s.endTime   ? new Date(s.endTime)   : null;
    const fmt   = d => d.toLocaleString('en-GB', { day: 'numeric', month: 'short',
                                                    hour: '2-digit', minute: '2-digit' });
    const timeStr = start && end ? `${fmt(start)} \u2013 ${fmt(end)}`
                  : start        ? `From ${fmt(start)}`
                  : '';

    return `
      <div class="disturbance-item">
        <div class="disturbance-severity-bar" style="background:${color}"></div>
        <div class="disturbance-content">
          <div class="disturbance-title">${title}</div>
          ${descTrunc ? `<div class="disturbance-desc">${descTrunc}</div>` : ''}
          ${timeStr   ? `<div class="disturbance-time">${timeStr}</div>`   : ''}
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// Refresh Loop
// ============================================================

function startRefreshLoop() {
  fetchVehiclePositions();
  fetchWeather();

  setInterval(() => {
    refreshCountdown = POLL_INTERVAL / 1000;
    fetchVehiclePositions();
  }, POLL_INTERVAL);

  setInterval(fetchWeather, WEATHER_REFRESH);

  setInterval(() => {
    refreshCountdown = Math.max(0, refreshCountdown - 1);
    refreshTimerEl.textContent = `${refreshCountdown}s`;
  }, 1000);
}

// ============================================================
// Sidebar Horizontal Resize
// ============================================================

(function () {
  const handle  = document.getElementById('resize-handle');
  const sidebar = document.getElementById('sidebar');
  const MIN_W   = 220;
  let dragging  = false;

  function startDrag() {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor        = 'col-resize';
    document.body.style.userSelect    = 'none';
    document.body.style.pointerEvents = 'none';
    handle.style.pointerEvents        = 'auto';
  }
  function onDrag(clientX) {
    if (!dragging) return;
    const w = Math.min(Math.floor(window.innerWidth * 0.9), Math.max(MIN_W, clientX));
    sidebar.style.width = sidebar.style.minWidth = w + 'px';
    map.invalidateSize();
  }
  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = document.body.style.userSelect = document.body.style.pointerEvents = '';
    handle.style.pointerEvents = '';
    map.invalidateSize();
  }

  handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(); });
  document.addEventListener('mousemove', e => onDrag(e.clientX));
  document.addEventListener('mouseup', stopDrag);
  handle.addEventListener('touchstart', e => { e.preventDefault(); startDrag(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); onDrag(e.touches[0].clientX); } }, { passive: false });
  document.addEventListener('touchend', stopDrag);
})();

// ============================================================
// Departure Board Vertical Resize
// ============================================================

(function () {
  const handle   = document.getElementById('resize-handle-v');
  const depCont  = document.getElementById('departure-container');
  const stopBtns = document.getElementById('stop-buttons');
  const sidebar  = document.getElementById('sidebar');
  const MIN_H    = 60;  // minimum departure board height
  const MIN_CTRL = 80;  // minimum space left for the controls/line list
  let dragging   = false;

  // Height of the departure board = distance from drag point to bottom of sidebar,
  // minus the stop-buttons strip. Bottom is always fixed.
  function calcDepHeight(clientY) {
    const sidebarBottom  = sidebar.getBoundingClientRect().bottom;
    const stopBtnsHeight = stopBtns.offsetHeight;
    const raw = sidebarBottom - clientY - stopBtnsHeight;
    const max = sidebar.offsetHeight - stopBtnsHeight - handle.offsetHeight - MIN_CTRL;
    return Math.min(max, Math.max(MIN_H, raw));
  }

  // Default: departure board = 80% of sidebar height
  function setDefaultHeight() {
    depCont.style.height = Math.floor(sidebar.offsetHeight * 0.8) + 'px';
  }
  setDefaultHeight();
  window.addEventListener('resize', setDefaultHeight);

  function startDrag() {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor        = 'row-resize';
    document.body.style.userSelect    = 'none';
    document.body.style.pointerEvents = 'none';
    handle.style.pointerEvents        = 'auto';
    window.removeEventListener('resize', setDefaultHeight);
  }
  function onDrag(clientY) {
    if (!dragging) return;
    depCont.style.height = calcDepHeight(clientY) + 'px';
  }
  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = document.body.style.userSelect = document.body.style.pointerEvents = '';
    handle.style.pointerEvents = '';
  }

  handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(); });
  document.addEventListener('mousemove', e => onDrag(e.clientY));
  document.addEventListener('mouseup', stopDrag);
  handle.addEventListener('touchstart', e => { e.preventDefault(); startDrag(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); onDrag(e.touches[0].clientY); } }, { passive: false });
  document.addEventListener('touchend', stopDrag);
})();

// ============================================================
// Boot — load default routes for lines 1 and 6 once positions arrive
// ============================================================

// Routes need a detailsReference from live data, so we fetch positions first,
// then trigger routes for the two default-selected lines.
async function boot() {
  await fetchVehiclePositions();
  fetchWeather();
  fetchDisturbances();

  ['1', '6'].forEach(name => {
    if (availableLines[name]?.refs.length > 0) fetchRouteForLine(name);
  });

  setInterval(() => {
    refreshCountdown = POLL_INTERVAL / 1000;
    fetchVehiclePositions();
  }, POLL_INTERVAL);

  setInterval(fetchWeather, WEATHER_REFRESH);
  setInterval(fetchDisturbances, DISTURBANCE_POLL);

  setInterval(() => {
    refreshCountdown = Math.max(0, refreshCountdown - 1);
    refreshTimerEl.textContent = `${refreshCountdown}s`;
  }, 1000);
}

boot();
