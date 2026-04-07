require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Västtrafik OAuth Token Management ---
let vtToken = null;
let vtTokenExpiry = 0;

async function getVtToken() {
  if (vtToken && Date.now() < vtTokenExpiry) return vtToken;

  const credentials = Buffer.from(
    `${process.env.VT_CLIENT_ID}:${process.env.VT_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://ext-api.vasttrafik.se/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  vtToken = data.access_token;
  vtTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  console.log('Västtrafik token refreshed, expires in', data.expires_in, 'seconds');
  return vtToken;
}

// Helper to make authenticated VT API calls
async function vtFetch(url) {
  const token = await getVtToken();
  return fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept-Language': 'en',
    },
  });
}

// --- Route geometry endpoint ---
// Given a journey detailsReference, fetches the stops and then
// fetches RouteLinks geometry (WGS84) for each consecutive stop pair.
app.get('/api/route/:detailsRef', async (req, res) => {
  try {
    const ref = req.params.detailsRef;

    // 1. Get journey details with stop calls
    const detUrl = `https://ext-api.vasttrafik.se/pr/v4/journeys/${encodeURIComponent(ref)}/details?includes=servicejourneycalls`;
    const detRes = await vtFetch(detUrl);
    if (!detRes.ok) {
      return res.status(detRes.status).json({ error: await detRes.text() });
    }
    const details = await detRes.json();

    const sj = details.tripLegs?.[0]?.serviceJourneys?.[0];
    const calls = sj?.callsOnServiceJourney || [];
    if (calls.length < 2) {
      return res.json({ stops: [], geometry: [] });
    }

    // 2. Extract stop info
    const stops = calls.map(c => ({
      name: c.stopPoint.name,
      gid: c.stopPoint.gid,
      lat: c.latitude || c.stopPoint.latitude,
      lng: c.longitude || c.stopPoint.longitude,
    }));

    // 3. Fetch RouteLinks geometry for each consecutive stop pair (in parallel)
    const linkPromises = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const fromGid = stops[i].gid;
      const toGid = stops[i + 1].gid;
      const url = `https://ext-api.vasttrafik.se/geo/v3/RouteLinks?offset=0&limit=1&includeGeometry=true&srid=4326&startsAtStopPointGid=${fromGid}&endsAtStopPointGid=${toGid}`;
      linkPromises.push(
        vtFetch(url)
          .then(r => r.ok ? r.json() : null)
          .then(d => d?.routeLinks?.[0]?.geometry?.wkt || null)
          .catch(() => null)
      );
    }

    const wktResults = await Promise.all(linkPromises);

    // 4. Parse WKT MULTILINESTRING into arrays of [lat, lng] coordinates
    const geometry = wktResults.map(wkt => {
      if (!wkt) return null;
      // Parse "MULTILINESTRING ((x1 y1, x2 y2, ...))"
      const match = wkt.match(/\(\((.+)\)\)/);
      if (!match) return null;
      return match[1].split(',').map(pair => {
        const [lng, lat] = pair.trim().split(/\s+/).map(Number);
        return [lat, lng]; // Leaflet uses [lat, lng]
      });
    });

    res.json({ stops, geometry });
  } catch (err) {
    console.error('Route fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Störning (Traffic Situations) v1 ---
const TS_BASE = 'https://ext-api.vasttrafik.se/ts/v1';

// --- Translation (sv → en) via free Google Translate endpoint ---
const translationCache = new Map(); // situationNumber → translated situation

async function translateText(text) {
  if (!text) return text;
  const url = 'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=sv&tl=en&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    // Response: [[["translated","original",...], ...], null, "sv"]
    return data[0].map(part => part[0]).join('');
  } catch {
    return text; // fall back to Swedish on error
  }
}

async function translateSituation(s) {
  const key = s.situationNumber || JSON.stringify(s);
  if (translationCache.has(key)) return translationCache.get(key);
  const [title, description] = await Promise.all([
    translateText(s.title),
    translateText(s.description),
  ]);
  const translated = { ...s, title, description };
  translationCache.set(key, translated);
  return translated;
}

app.get('/api/disturbances/line/:gid', async (req, res) => {
  try {
    const url = `${TS_BASE}/traffic-situations/line/${encodeURIComponent(req.params.gid)}`;
    const r = await vtFetch(url);
    if (!r.ok) {
      const body = await r.text();
      console.error(`Störning line error: ${r.status} ${body}`);
      return res.status(r.status).json({ error: body });
    }
    const data = await r.json();
    const situations = Array.isArray(data) ? data : data?.trafficSituations ?? data?.results ?? [];
    const translated = await Promise.all(situations.map(translateSituation));
    res.json(translated);
  } catch (err) {
    console.error('Disturbance line error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: line GIDs for tram lines 1 and 6 from live positions
app.get('/api/debug/linegids', async (req, res) => {
  try {
    const params = new URLSearchParams({
      lowerLeftLat: 57.58, lowerLeftLong: 11.80,
      upperRightLat: 57.82, upperRightLong: 12.15,
      limit: 200,
    });
    ['1','6'].forEach(l => params.append('lineDesignations', l));
    const r = await vtFetch(`https://ext-api.vasttrafik.se/pr/v4/positions?${params}`);
    const vehicles = await r.json();
    const lines = {};
    (Array.isArray(vehicles) ? vehicles : []).forEach(v => {
      const desig = v.line?.designation || v.line?.name;
      if (desig && !lines[desig]) lines[desig] = v.line;
    });
    res.json(lines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: raw Störning responses for both stop GIDs
app.get('/api/disturbances/debug', async (req, res) => {
  const gids = {
    olivedalsgatan: '9021014005140000',
    linneplatsen:   '9021014004510000',
  };
  const result = {};
  for (const [name, gid] of Object.entries(gids)) {
    for (const path of ['stoparea', 'stoppoint']) {
      const url = `${TS_BASE}/traffic-situations/${path}/${gid}${TS_LANG}`;
      try {
        const r = await vtFetch(url);
        const text = await r.text();
        result[`${name}_${path}`] = { status: r.status, body: text.slice(0, 2000) };
      } catch (e) {
        result[`${name}_${path}`] = { error: e.message };
      }
    }
  }
  res.json(result);
});

app.get('/api/disturbances/stop/:gid', async (req, res) => {
  try {
    const gid = req.params.gid;

    // Try stoparea first (our buttons carry stop-area GIDs 9021014…).
    // Fall back to stoppoint if stoparea returns 404 / empty.
    let situations = [];

    const areaUrl = `${TS_BASE}/traffic-situations/stoparea/${encodeURIComponent(gid)}`;
    const areaRes = await vtFetch(areaUrl);
    if (areaRes.ok) {
      const data = await areaRes.json();
      situations = Array.isArray(data) ? data
                 : data?.trafficSituations ?? data?.results ?? [];
    }

    // If stoparea gave nothing, also try stoppoint with the same GID
    if (situations.length === 0) {
      const ptUrl = `${TS_BASE}/traffic-situations/stoppoint/${encodeURIComponent(gid)}`;
      const ptRes = await vtFetch(ptUrl);
      if (ptRes.ok) {
        const data = await ptRes.json();
        situations = Array.isArray(data) ? data
                   : data?.trafficSituations ?? data?.results ?? [];
      } else {
        console.log(`Störning stoppoint ${ptRes.status} for ${gid}`);
      }
    }

    // Keep only situations that directly affect a stop point belonging to this stop area
    const relevant = situations.filter(s =>
      Array.isArray(s.affectedStopPoints) &&
      s.affectedStopPoints.some(pt => pt.stopAreaGid === gid)
    );

    // Translate title + description sv → en (cached by situationNumber)
    const translated = await Promise.all(relevant.map(translateSituation));
    res.json(translated);
  } catch (err) {
    console.error('Disturbance stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Proxy middleware for Västtrafik Planera Resa API ---
app.get('/api/vt/*', async (req, res) => {
  try {
    const vtPath = req.params[0];
    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://ext-api.vasttrafik.se/pr/v4/${vtPath}${queryString ? '?' + queryString : ''}`;

    const vtRes = await vtFetch(url);

    if (!vtRes.ok) {
      const body = await vtRes.text();
      console.error(`VT API error: ${vtRes.status} ${body}`);
      return res.status(vtRes.status).json({ error: body });
    }

    const data = await vtRes.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Weather proxy (met.no requires a User-Agent header) ---
app.get('/api/weather', async (req, res) => {
  try {
    const r = await fetch(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=57.7089&lon=11.9746',
      { headers: { 'User-Agent': 'GothenburgTransitDashboard/1.0 contact@example.com' } }
    );
    if (!r.ok) throw new Error(`met.no ${r.status}`);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await r.json());
  } catch (err) {
    console.error('Weather proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Serve static files ---
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
