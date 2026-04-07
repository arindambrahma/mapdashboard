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

// met.no symbol code → [emoji, description]
const MET_SYMBOLS = {
  clearsky:            ['\u2600\ufe0f', 'Clear sky'],
  fair:                ['\ud83c\udf24\ufe0f', 'Mainly clear'],
  partlycloudy:        ['\u26c5', 'Partly cloudy'],
  cloudy:              ['\u2601\ufe0f', 'Cloudy'],
  fog:                 ['\ud83c\udf2b\ufe0f', 'Fog'],
  lightrain:           ['\ud83c\udf26\ufe0f', 'Light rain'],
  rain:                ['\ud83c\udf27\ufe0f', 'Rain'],
  heavyrain:           ['\ud83c\udf27\ufe0f', 'Heavy rain'],
  lightrainshowers:    ['\ud83c\udf26\ufe0f', 'Light showers'],
  rainshowers:         ['\ud83c\udf27\ufe0f', 'Showers'],
  heavyrainshowers:    ['\u26c8\ufe0f', 'Heavy showers'],
  lightsleet:          ['\ud83c\udf28\ufe0f', 'Light sleet'],
  sleet:               ['\ud83c\udf28\ufe0f', 'Sleet'],
  lightsleetshowers:   ['\ud83c\udf28\ufe0f', 'Light sleet showers'],
  sleetshowers:        ['\ud83c\udf28\ufe0f', 'Sleet showers'],
  lightsnow:           ['\ud83c\udf28\ufe0f', 'Light snow'],
  snow:                ['\u2744\ufe0f', 'Snow'],
  heavysnow:           ['\u2744\ufe0f', 'Heavy snow'],
  lightsnowshowers:    ['\ud83c\udf28\ufe0f', 'Light snow showers'],
  snowshowers:         ['\u2744\ufe0f', 'Snow showers'],
  heavysnowshowers:    ['\u2744\ufe0f', 'Heavy snow showers'],
  thunder:             ['\u26c8\ufe0f', 'Thunder'],
  rainandthunder:      ['\u26c8\ufe0f', 'Rain & thunder'],
  lightrainandthunder: ['\u26c8\ufe0f', 'Light rain & thunder'],
  heavyrainandthunder: ['\u26c8\ufe0f', 'Heavy rain & thunder'],
  snowandthunder:      ['\u26c8\ufe0f', 'Snow & thunder'],
  sleetandthunder:     ['\u26c8\ufe0f', 'Sleet & thunder'],
};

function metSymbol(code) {
  if (!code) return ['\ud83c\udf21\ufe0f', 'Unknown'];
  const base = code.replace(/_(day|night|polartwilight)$/, '');
  return MET_SYMBOLS[base] || ['\ud83c\udf21\ufe0f', base];
}

function windChill(tempC, windMs) {
  const windKmh = windMs * 3.6;
  if (tempC > 10 || windKmh < 4.8) return tempC;
  return 13.12 + 0.6215 * tempC - 11.37 * Math.pow(windKmh, 0.16) + 0.3965 * tempC * Math.pow(windKmh, 0.16);
}

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
  fetchDisturbances();
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

async function fetchWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`Weather ${res.status}`);
    renderWeather(await res.json());
  } catch (err) {
    document.getElementById('weather-desc').textContent = 'Weather unavailable';
  }
}

function renderWeather(data) {
  const ts  = data.properties.timeseries;
  const now = Date.now();

  // Find the timeslot that covers right now
  let ci = ts.findLastIndex(t => new Date(t.time).getTime() <= now);
  if (ci < 0) ci = 0;

  const cur     = ts[ci].data;
  const details = cur.instant.details;
  const next1h  = cur.next_1_hours || cur.next_6_hours;
  const [emoji, desc] = metSymbol(next1h?.summary?.symbol_code);
  const feels   = Math.round(windChill(details.air_temperature, details.wind_speed));
  const windKmh = Math.round(details.wind_speed * 3.6);
  const precipProb = Math.round(next1h?.details?.probability_of_precipitation ?? 0);

  document.getElementById('weather-icon').textContent  = emoji;
  document.getElementById('weather-temp').textContent  = `${Math.round(details.air_temperature)}\u00b0C`;
  document.getElementById('weather-feels').textContent = `Feels ${feels}\u00b0C`;
  document.getElementById('weather-desc').textContent  = desc;
  document.getElementById('weather-wind').textContent  = `\ud83d\udca8 ${windKmh} km/h`;
  document.getElementById('weather-rain').textContent  = `\ud83c\udf27 ${precipProb}%`;

  // --- Hourly forecast strip (current + next 8 hourly slots) ---
  const labelFor = t => new Date(t).toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm', hour: '2-digit',
  });

  const hours = [
    { label: labelFor(ts[ci].time), prob: precipProb, emoji },
    ...ts.slice(ci + 1)
         .filter(t => t.data.next_1_hours)
         .slice(0, 8)
         .map(t => {
           const h1  = t.data.next_1_hours;
           const prob = Math.round(h1?.details?.probability_of_precipitation ?? 0);
           return { label: labelFor(t.time), prob, emoji: metSymbol(h1?.summary?.symbol_code)[0] };
         }),
  ];

  const nextRain   = hours.slice(1).find(h => h.prob >= 40);
  const rainSummary = nextRain
    ? `Rain possible around ${nextRain.label}:00`
    : hours[0].prob >= 40 ? 'Rain likely now' : 'No rain expected soon';

  const forecastEl = document.getElementById('weather-forecast');
  const hourCols = hours.map(h => {
    const color = h.prob >= 70 ? '#00b4d8' : h.prob >= 40 ? '#78909c' : '#37474f';
    const barH  = Math.max(0.125, +(h.prob * 0.01375).toFixed(3)); // em units
    return `
      <div class="forecast-hour">
        <div class="forecast-time">${h.label}</div>
        <div class="forecast-emoji">${h.emoji}</div>
        <div class="forecast-bar" style="height:${barH}em;background:${color}"></div>
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

function lineNameToGid(name) {
  const num = parseInt(name, 10);
  if (!num) return null; // 'X' or non-numeric
  return `9011014` + `5${String(num).padStart(3, '0')}00000`;
}

async function fetchDisturbances() {
  const lines = selectedLines.size > 0
    ? [...selectedLines]
    : STATIC_TRAM_LINES.map(l => l.name);

  const gids = lines.map(lineNameToGid).filter(Boolean);
  if (gids.length === 0) return;

  try {
    const results = await Promise.all(
      gids.map(gid =>
        fetch(`/api/disturbances/line/${encodeURIComponent(gid)}`)
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      )
    );

    const situMap = new Map();
    results.flat().forEach(s => {
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

  // Set up click-to-expand toggle (attach once)
  if (!overlay.dataset.toggleReady) {
    overlay.dataset.toggleReady = '1';
    document.getElementById('disturbance-header').addEventListener('click', () => {
      overlay.classList.toggle('collapsed');
    });
  }

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

// ============================================================
// Weather Widget — resize drag (bottom-left handle)
// ============================================================
(function () {
  const widget = document.getElementById('weather-widget');
  const handle = document.getElementById('weather-resize-handle');
  const BASE_WIDTH = 270;

  function updateScale() {
    widget.style.fontSize = (widget.offsetWidth / BASE_WIDTH) + 'rem';
  }

  function startResize(clientX) {
    const startX     = clientX;
    const startWidth = widget.offsetWidth;

    function onMove(clientX) {
      const dx = startX - clientX;           // dragging left = wider
      const w  = Math.max(160, Math.min(520, startWidth + dx));
      widget.style.width = w + 'px';
      updateScale();
    }

    function onMouseMove(e) { onMove(e.clientX); }
    function onTouchMove(e) { onMove(e.touches[0].clientX); }

    function cleanup() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   cleanup);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend',  cleanup);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   cleanup);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend',  cleanup);
  }

  handle.addEventListener('mousedown',  e => { e.preventDefault(); startResize(e.clientX); });
  handle.addEventListener('touchstart', e => { startResize(e.touches[0].clientX); }, { passive: true });
}());

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

// ============================================================
// TEMPORARY — Pane size inspector (remove when defaults are set)
// ============================================================
(function () {
  const panel = document.createElement('div');
  panel.id = 'pane-size-debug';
  Object.assign(panel.style, {
    position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 9999, background: 'rgba(0,0,0,0.82)', color: '#00e5ff',
    fontFamily: 'monospace', fontSize: '12px', padding: '8px 14px',
    borderRadius: '8px', border: '1px solid #00b4d8', pointerEvents: 'none',
    whiteSpace: 'nowrap', lineHeight: '1.7',
  });
  document.body.appendChild(panel);

  const sidebar  = document.getElementById('sidebar');
  const depCont  = document.getElementById('departure-container');
  const weather  = document.getElementById('weather-widget');

  function update() {
    panel.innerHTML =
      `sidebar: <b>${sidebar.offsetWidth}px</b> wide` +
      `&nbsp;&nbsp;|&nbsp;&nbsp;` +
      `departure board: <b>${depCont.offsetHeight}px</b> tall` +
      `&nbsp;&nbsp;|&nbsp;&nbsp;` +
      `weather widget: <b>${weather.offsetWidth}px</b> wide`;
  }

  update();
  const ro = new ResizeObserver(update);
  [sidebar, depCont, weather].forEach(el => ro.observe(el));
}());
// ============================================================

boot();
