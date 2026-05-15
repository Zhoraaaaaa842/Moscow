import { getDistrictInfo, getOkrugList, getDistrictsByOkrug, DISTRICTS_META } from './districts.js';

// =============================================
//  TAURI — безопасный импорт
// =============================================
let tauriInvoke = null;

async function initTauriBridge() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    tauriInvoke = invoke;
  } catch (_) {
    tauriInvoke = async (cmd, args) => {
      if (cmd === 'get_visited_districts') return JSON.parse(localStorage.getItem('visited') || '[]');
      if (cmd === 'save_visited_districts') { localStorage.setItem('visited', JSON.stringify(args.districts)); return true; }
      return null;
    };
  }
}

// =============================================
//  СОСТОЯНИЕ
// =============================================
let map, geojsonLayer, geojsonData = null;
let visitedDistricts = new Set();
let activeDistrict = null;
let activeOkrug = 'Все';
const DISTRICT_NAMES = new Set(Object.keys(DISTRICTS_META));
const TOTAL = DISTRICT_NAMES.size;

// =============================================
//  КАРТА
// =============================================
function initMap() {
  map = L.map('map', { center: [55.751244, 37.618423], zoom: 11 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://openstreetmap.org/copyright" target="_blank">OSM</a> © <a href="https://carto.com" target="_blank">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(map);
}

// =============================================
//  GeoJSON — загрузка с Overpass API
// =============================================
async function loadGeoJSON() {
  // Запрашиваем все районы Москвы через Overpass API
  const query = `
    [out:json][timeout:60];
    area["name"="Москва"][admin_level=2]->.moscow;
    (
      relation["admin_level"="8"]["boundary"="administrative"](area.moscow);
    );
    out geom;
  `;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error('Overpass failed');
    const data = await res.json();
    geojsonData = overpassToGeoJSON(data);
  } catch (e) {
    console.warn('Overpass недоступен, используем fallback:', e);
    geojsonData = getFallbackGeoJSON();
  }
  geojsonData = normalizeGeoJSONToKnownDistricts(geojsonData);
  renderGeoJSON();
}

function normalizeGeoJSONToKnownDistricts(data) {
  if (!data?.features?.length) return getFallbackGeoJSON();
  const byName = new Map();
  for (const feature of data.features) {
    const name = getDistrictName(feature);
    if (!DISTRICT_NAMES.has(name)) continue;
    if (!byName.has(name)) byName.set(name, feature);
  }
  if (!byName.size) return getFallbackGeoJSON();
  return { type: 'FeatureCollection', features: [...byName.values()] };
}

function overpassToGeoJSON(data) {
  const features = [];
  for (const el of data.elements) {
    if (el.type !== 'relation' || !el.members) continue;
    const name = el.tags?.name || el.tags?.['name:ru'] || 'Неизвестный район';
    // Собираем кольца из members
    const outerWays = el.members.filter(m => m.type === 'way' && m.role === 'outer');
    if (!outerWays.length) continue;
    // Берём первый outer way как полигон
    const coords = outerWays[0].geometry?.map(p => [p.lon, p.lat]) || [];
    if (coords.length < 3) continue;
    if (coords[0][0] !== coords[coords.length-1][0]) coords.push(coords[0]);
    features.push({
      type: 'Feature',
      properties: { name },
      geometry: { type: 'Polygon', coordinates: [coords] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function getDistrictName(feature) {
  return feature.properties?.name || feature.properties?.NAME || 'Неизвестный';
}

function getStyle(feature) {
  const name = getDistrictName(feature);
  const visited = visitedDistricts.has(name);
  const active  = name === activeDistrict;
  const meta    = DISTRICTS_META[name];
  const okrugMatch = activeOkrug === 'Все' || meta?.okrug === activeOkrug;
  return {
    fillColor:   active  ? '#6daa45' : visited ? '#4f98a3' : '#2a2926',
    fillOpacity: active  ? 0.5 : visited ? 0.38 : okrugMatch ? 0.18 : 0.06,
    color:       active  ? '#6daa45' : visited ? '#4f98a3' : okrugMatch ? '#3d3c38' : '#232220',
    weight:      active  ? 2.5 : 1.2,
    opacity:     okrugMatch ? 0.9 : 0.3,
  };
}

function renderGeoJSON() {
  if (geojsonLayer) geojsonLayer.remove();
  geojsonLayer = L.geoJSON(geojsonData, {
    style: getStyle,
    onEachFeature(feature, layer) {
      const name = getDistrictName(feature);
      layer.on({
        click() { selectDistrict(name, layer); },
        mouseover(e) {
          e.target.setStyle({ fillOpacity: 0.55, weight: 2 });
          const meta = DISTRICTS_META[name];
          const badge = meta ? ` <span style="color:#4f98a3;font-size:0.7em">${meta.okrug}</span>` : '';
          e.target.bindPopup(`<strong>${name}</strong>${badge}${visitedDistricts.has(name) ? ' ✅' : ''}`, {closeButton:false}).openPopup();
        },
        mouseout(e) { geojsonLayer.resetStyle(e.target); map.closePopup(); },
      });
    },
  }).addTo(map);
}

function refreshStyles() {
  if (geojsonLayer) geojsonLayer.setStyle(getStyle);
}

// =============================================
//  ВЫБОР РАЙОНА
// =============================================
function selectDistrict(name, layer) {
  activeDistrict = name;
  refreshStyles();
  showDistrictCard(name);
  hideStats();
  closeSearch();
  if (layer?.getBounds) map.fitBounds(layer.getBounds(), { padding: [60, 60] });
}

function selectRandom() {
  if (!geojsonData?.features?.length) return;
  const scoped = geojsonData.features.filter(f => {
    const n = getDistrictName(f);
    return activeOkrug === 'Все' || DISTRICTS_META[n]?.okrug === activeOkrug;
  });
  if (!scoped.length) {
    showToast('Для выбранного округа нет доступных районов');
    return;
  }
  const pool = scoped.filter(f => {
    const n = getDistrictName(f);
    const notVisited = !visitedDistricts.has(n);
    return notVisited;
  });
  const source = pool.length > 0 ? pool : scoped;
  const pick = source[Math.floor(Math.random() * source.length)];
  if (!pick) return;
  const name = getDistrictName(pick);
  let targetLayer = null;
  geojsonLayer?.eachLayer(l => { if (getDistrictName(l.feature) === name) targetLayer = l; });
  selectDistrict(name, targetLayer);
}

// =============================================
//  КАРТОЧКА РАЙОНА
// =============================================
function showDistrictCard(name) {
  const card   = document.getElementById('district-card');
  const title  = document.getElementById('district-name');
  const list   = document.getElementById('places-list');
  const btnV   = document.getElementById('btn-visited');
  const badge  = document.getElementById('district-okrug-badge');
  const empty  = document.getElementById('empty-state');

  const meta = getDistrictInfo(name);
  title.textContent  = name;
  badge.textContent  = meta.okrug || '';
  card.classList.remove('hidden');
  empty.style.display = 'none';

  list.innerHTML = '<div class="loading-skeleton"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  btnV.disabled  = visitedDistricts.has(name);
  btnV.innerHTML = visitedDistricts.has(name) ? '✅ Посещён' : '✓ Был здесь';

  setTimeout(() => {
    list.innerHTML = '';
    meta.places.forEach(p => {
      const el = document.createElement('div');
      el.className = 'place-item';
      el.innerHTML = `<span class="place-icon">${meta.icon}</span><div class="place-info"><span class="place-name">${p.name}</span><span class="place-type">${p.type}</span></div>`;
      list.appendChild(el);
    });
  }, 250);
}

// =============================================
//  ПРОГРЕСС
// =============================================
function updateProgress() {
  const n = visitedDistricts.size;
  document.getElementById('visited-count').textContent = `${n} / ${TOTAL}`;
  document.getElementById('progress-fill').style.width = `${(n / TOTAL) * 100}%`;
}

// =============================================
//  СТАТИСТИКА ПО ОКРУГАМ
// =============================================
function showStats() {
  const panel = document.getElementById('stats-panel');
  const list  = document.getElementById('stats-list');
  const card  = document.getElementById('district-card');
  card.classList.add('hidden');
  document.getElementById('empty-state').style.display = 'none';
  panel.classList.remove('hidden');

  // Собираем данные
  const okrugs = {};
  for (const [name, meta] of Object.entries(DISTRICTS_META)) {
    const ok = meta.okrug;
    if (!okrugs[ok]) okrugs[ok] = { total: 0, visited: 0 };
    okrugs[ok].total++;
    if (visitedDistricts.has(name)) okrugs[ok].visited++;
  }

  list.innerHTML = '';
  for (const [ok, d] of Object.entries(okrugs).sort()) {
    const pct = d.total > 0 ? Math.round((d.visited / d.total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `
      <div class="stat-row-header">
        <span class="stat-okrug">${ok}</span>
        <span class="stat-nums"><b>${d.visited}</b> / ${d.total} (${pct}%)</span>
      </div>
      <div class="stat-bar"><div class="stat-bar-fill" style="width:0%" data-target="${pct}"></div></div>`;
    list.appendChild(row);
  }
  // Анимация баров
  requestAnimationFrame(() => {
    list.querySelectorAll('.stat-bar-fill').forEach(el => {
      el.style.width = el.dataset.target + '%';
    });
  });
}

function hideStats() {
  document.getElementById('stats-panel').classList.add('hidden');
}

// =============================================
//  ПОИСК
// =============================================
function initSearch() {
  const input   = document.getElementById('search-input');
  const clear   = document.getElementById('search-clear');
  const wrap    = document.querySelector('.search-wrap');
  let dropdown  = null;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    clear.classList.toggle('visible', q.length > 0);
    if (!q) { removeDropdown(); return; }
    const matches = Object.keys(DISTRICTS_META).filter(n => n.toLowerCase().includes(q)).slice(0, 8);
    showDropdown(matches);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.classList.remove('visible');
    removeDropdown();
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) removeDropdown();
  });

  function showDropdown(items) {
    removeDropdown();
    if (!items.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'search-results';
    items.forEach(name => {
      const meta = DISTRICTS_META[name];
      const row = document.createElement('div');
      row.className = 'search-result-item';
      row.innerHTML = `<span>${meta.icon}</span><span>${name}</span><span class="search-result-okrug">${meta.okrug}</span>`;
      row.addEventListener('click', () => {
        input.value = name;
        clear.classList.add('visible');
        removeDropdown();
        // Найти и выбрать на карте
        let found = null;
        geojsonLayer?.eachLayer(l => { if (getDistrictName(l.feature) === name) found = l; });
        if (found) {
          selectDistrict(name, found);
        } else {
          activeDistrict = name;
          showDistrictCard(name);
        }
      });
      dropdown.appendChild(row);
    });
    wrap.appendChild(dropdown);
  }

  function removeDropdown() {
    dropdown?.remove();
    dropdown = null;
  }
}

function closeSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.remove('visible');
}

// =============================================
//  ФИЛЬТР ПО ОКРУГУ
// =============================================
function initOkrugFilters() {
  const container = document.getElementById('okrug-filters');
  const okrugs = getOkrugList();
  okrugs.forEach(ok => {
    const btn = document.createElement('button');
    btn.className = 'okrug-btn' + (ok === 'Все' ? ' active' : '');
    btn.textContent = ok;
    btn.addEventListener('click', () => {
      activeOkrug = ok;
      container.querySelectorAll('.okrug-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refreshStyles();
    });
    container.appendChild(btn);
  });
}

// =============================================
//  ЭКСПОРТ МАРШРУТА
// =============================================
function exportRoute() {
  if (!activeDistrict) return;
  const meta = getDistrictInfo(activeDistrict);
  const lines = [
    `🗺️ Маршрут: ${activeDistrict}`,
    `Округ: ${meta.okrug}`,
    ``,
    `Интересные места:`,
    ...meta.places.map((p, i) => `${i + 1}. ${p.name} — ${p.type}`),
    ``,
    `Сгенерировано: Moscow Walk`,
  ];
  const text = lines.join('\n');
  // Копируем в буфер
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Маршрут скопирован в буфер обмена');
  }).catch(() => {
    // Fallback — скачать как .txt
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${activeDistrict}_маршрут.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Маршрут сохранён как файл');
  });
}

// =============================================
//  TOAST
// =============================================
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 2800);
}

// =============================================
//  СОХРАНЕНИЕ
// =============================================
async function loadVisited() {
  try { visitedDistricts = new Set(await tauriInvoke('get_visited_districts')); } catch (_) {}
  updateProgress();
}
async function saveVisited() {
  try { await tauriInvoke('save_visited_districts', { districts: [...visitedDistricts] }); } catch (_) {}
}

// =============================================
//  FALLBACK GeoJSON (12 районов)
// =============================================
function getFallbackGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [
      {type:'Feature',properties:{name:'Арбат'},geometry:{type:'Polygon',coordinates:[[[37.57,55.74],[37.60,55.74],[37.60,55.76],[37.57,55.76],[37.57,55.74]]]}},
      {type:'Feature',properties:{name:'Пресненский'},geometry:{type:'Polygon',coordinates:[[[37.55,55.755],[37.59,55.755],[37.59,55.775],[37.55,55.775],[37.55,55.755]]]}},
      {type:'Feature',properties:{name:'Тверской'},geometry:{type:'Polygon',coordinates:[[[37.59,55.755],[37.63,55.755],[37.63,55.775],[37.59,55.775],[37.59,55.755]]]}},
      {type:'Feature',properties:{name:'Замоскворечье'},geometry:{type:'Polygon',coordinates:[[[37.61,55.725],[37.65,55.725],[37.65,55.745],[37.61,55.745],[37.61,55.725]]]}},
      {type:'Feature',properties:{name:'Якиманка'},geometry:{type:'Polygon',coordinates:[[[37.58,55.725],[37.62,55.725],[37.62,55.745],[37.58,55.745],[37.58,55.725]]]}},
      {type:'Feature',properties:{name:'Хамовники'},geometry:{type:'Polygon',coordinates:[[[37.54,55.715],[37.60,55.715],[37.60,55.745],[37.54,55.745],[37.54,55.715]]]}},
      {type:'Feature',properties:{name:'Гагаринский'},geometry:{type:'Polygon',coordinates:[[[37.52,55.68],[37.59,55.68],[37.59,55.72],[37.52,55.72],[37.52,55.68]]]}},
      {type:'Feature',properties:{name:'Дорогомилово'},geometry:{type:'Polygon',coordinates:[[[37.49,55.73],[37.55,55.73],[37.55,55.755],[37.49,55.755],[37.49,55.73]]]}},
      {type:'Feature',properties:{name:'Измайлово'},geometry:{type:'Polygon',coordinates:[[[37.76,55.77],[37.83,55.77],[37.83,55.81],[37.76,55.81],[37.76,55.77]]]}},
      {type:'Feature',properties:{name:'Сокольники'},geometry:{type:'Polygon',coordinates:[[[37.66,55.78],[37.72,55.78],[37.72,55.82],[37.66,55.82],[37.66,55.78]]]}},
      {type:'Feature',properties:{name:'Даниловский'},geometry:{type:'Polygon',coordinates:[[[37.61,55.705],[37.66,55.705],[37.66,55.73],[37.61,55.73],[37.61,55.705]]]}},
      {type:'Feature',properties:{name:'Таганский'},geometry:{type:'Polygon',coordinates:[[[37.64,55.73],[37.69,55.73],[37.69,55.755],[37.64,55.755],[37.64,55.73]]]}},
    ]
  };
}

// =============================================
//  СОБЫТИЯ
// =============================================
document.getElementById('btn-random').addEventListener('click', selectRandom);

document.getElementById('btn-stats').addEventListener('click', () => {
  const panel = document.getElementById('stats-panel');
  if (panel.classList.contains('hidden')) showStats();
  else hideStats();
});

document.getElementById('btn-visited').addEventListener('click', async () => {
  if (!activeDistrict) return;
  visitedDistricts.add(activeDistrict);
  refreshStyles();
  updateProgress();
  await saveVisited();
  const btn = document.getElementById('btn-visited');
  btn.disabled = true;
  btn.innerHTML = '✅ Посещён';
  showToast(`✅ ${activeDistrict} отмечен посещённым!`);
});

document.getElementById('btn-export').addEventListener('click', exportRoute);

// =============================================
//  СТАРТ
// =============================================
async function bootstrap() {
  await initTauriBridge();
  initMap();
  initOkrugFilters();
  initSearch();
  await loadVisited();
  await loadGeoJSON();
}

bootstrap();
