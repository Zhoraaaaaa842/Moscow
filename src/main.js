import { getDistrictInfo } from './districts.js';

// =============================================
//  TAURI — безопасный импорт (в браузере тоже работает)
// =============================================
let tauriInvoke = null;
try {
  const { invoke } = await import('@tauri-apps/api/core');
  tauriInvoke = invoke;
} catch (_) {
  // Запущено в браузере (vite preview) — используем localStorage-заглушку
  tauriInvoke = async (cmd, args) => {
    if (cmd === 'get_visited_districts') {
      return JSON.parse(localStorage.getItem('visited') || '[]');
    }
    if (cmd === 'save_visited_districts') {
      localStorage.setItem('visited', JSON.stringify(args.districts));
      return true;
    }
  };
}

// =============================================
//  СОСТОЯНИЕ
// =============================================
let map;
let geojsonLayer;
let geojsonData = null;
let visitedDistricts = new Set();
let activeLayer = null;
let activeDistrict = null;
const TOTAL_DISTRICTS_DISPLAY = 125;

// =============================================
//  ИНИЦИАЛИЗАЦИЯ КАРТЫ
// =============================================
function initMap() {
  map = L.map('map', {
    center: [55.751244, 37.618423],
    zoom: 11,
    zoomControl: true,
    attributionControl: true,
  });

  // Dark tile layer (CartoDB Dark Matter)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OSM</a> © <a href="https://carto.com/" target="_blank">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

// =============================================
//  ЗАГРУЗКА GeoJSON РАЙОНОВ
// =============================================
async function loadGeoJSON() {
  // Используем публичный Overpass API для получения районов Москвы
  // Для production лучше хранить GeoJSON локально
  const GEOJSON_URL = 'https://raw.githubusercontent.com/nicot/osm-geojson/master/data/RU/city/Moscow/districts.geojson';
  
  try {
    const res = await fetch(GEOJSON_URL);
    if (!res.ok) throw new Error('GeoJSON fetch failed');
    geojsonData = await res.json();
  } catch (e) {
    // Fallback — простые полигоны нескольких районов
    geojsonData = getFallbackGeoJSON();
  }
  renderGeoJSON();
}

function getDistrictName(feature) {
  return feature.properties?.name ||
         feature.properties?.NAME ||
         feature.properties?.district ||
         'Неизвестный район';
}

function getStyle(feature) {
  const name = getDistrictName(feature);
  const visited = visitedDistricts.has(name);
  const active  = name === activeDistrict;
  return {
    fillColor:   active  ? '#6daa45' : visited ? '#4f98a3' : '#2a2926',
    fillOpacity: active  ? 0.45       : visited ? 0.35      : 0.15,
    color:       active  ? '#6daa45' : visited ? '#4f98a3' : '#3d3c38',
    weight:      active  ? 2.5        : 1.5,
    opacity:     0.9,
  };
}

function renderGeoJSON() {
  if (geojsonLayer) { geojsonLayer.remove(); }

  geojsonLayer = L.geoJSON(geojsonData, {
    style: getStyle,
    onEachFeature(feature, layer) {
      const name = getDistrictName(feature);
      layer.on({
        click() { selectDistrict(name, layer); },
        mouseover(e) {
          e.target.setStyle({ fillOpacity: 0.6, weight: 2.5 });
          e.target.bindPopup(`<strong>${name}</strong>${visitedDistricts.has(name) ? ' ✅' : ''}`).openPopup();
        },
        mouseout(e) {
          geojsonLayer.resetStyle(e.target);
          map.closePopup();
        },
      });
    },
  }).addTo(map);
}

function refreshStyles() {
  if (!geojsonLayer) return;
  geojsonLayer.setStyle(getStyle);
}

// =============================================
//  ВЫБОР РАЙОНА
// =============================================
function selectDistrict(name, layer) {
  activeDistrict = name;
  activeLayer = layer;
  refreshStyles();
  showDistrictCard(name);
  // Центрировать карту на районе
  if (layer && layer.getBounds) {
    map.fitBounds(layer.getBounds(), { padding: [60, 60] });
  }
}

function selectRandom() {
  if (!geojsonData || !geojsonData.features?.length) return;
  const features = geojsonData.features;
  const unvisited = features.filter(f => !visitedDistricts.has(getDistrictName(f)));
  const pool = unvisited.length > 0 ? unvisited : features;
  const feature = pool[Math.floor(Math.random() * pool.length)];
  const name = getDistrictName(feature);

  // Найти соответствующий layer
  let targetLayer = null;
  geojsonLayer.eachLayer(l => {
    if (getDistrictName(l.feature) === name) targetLayer = l;
  });
  selectDistrict(name, targetLayer);
}

// =============================================
//  КАРТОЧКА РАЙОНА
// =============================================
function showDistrictCard(name) {
  const card     = document.getElementById('district-card');
  const title    = document.getElementById('district-name');
  const list     = document.getElementById('places-list');
  const btnV     = document.getElementById('btn-visited');
  const empty    = document.getElementById('empty-state');

  title.textContent = name;
  card.classList.remove('hidden');
  empty.style.display = 'none';

  // Скелетон пока не загрузилось
  list.innerHTML = '<div class="loading-skeleton"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';

  btnV.disabled = visitedDistricts.has(name);
  btnV.textContent = visitedDistricts.has(name) ? '✅ Посещён' : '✓ Был здесь';

  // Маленький таймаут — имитация запроса
  setTimeout(() => {
    const info = getDistrictInfo(name);
    list.innerHTML = '';
    info.places.forEach(p => {
      const el = document.createElement('div');
      el.className = 'place-item';
      el.innerHTML = `
        <span class="place-icon">${info.icon}</span>
        <div class="place-info">
          <span class="place-name">${p.name}</span>
          <span class="place-type">${p.type}</span>
        </div>`;
      list.appendChild(el);
    });
  }, 320);
}

// =============================================
//  ПРОГРЕСС
// =============================================
function updateProgress() {
  const n = visitedDistricts.size;
  document.getElementById('visited-count').textContent = `${n} / ${TOTAL_DISTRICTS_DISPLAY}`;
  document.getElementById('progress-fill').style.width = `${(n / TOTAL_DISTRICTS_DISPLAY) * 100}%`;
}

// =============================================
//  СОХРАНЕНИЕ / ЗАГРУЗКА
// =============================================
async function loadVisited() {
  try {
    const arr = await tauriInvoke('get_visited_districts');
    visitedDistricts = new Set(arr);
  } catch (_) {}
  updateProgress();
}

async function saveVisited() {
  try {
    await tauriInvoke('save_visited_districts', { districts: [...visitedDistricts] });
  } catch (_) {}
}

// =============================================
//  СОБЫТИЯ
// =============================================
document.getElementById('btn-random').addEventListener('click', selectRandom);

document.getElementById('btn-visited').addEventListener('click', async () => {
  if (!activeDistrict) return;
  visitedDistricts.add(activeDistrict);
  refreshStyles();
  updateProgress();
  await saveVisited();
  const btn = document.getElementById('btn-visited');
  btn.disabled = true;
  btn.textContent = '✅ Посещён';
});

// =============================================
//  FALLBACK GeoJSON (несколько районов Москвы)
// Используется если внешний источник недоступен
// =============================================
function getFallbackGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [
      { type:'Feature', properties:{name:'Арбат'}, geometry:{type:'Polygon',coordinates:[[[37.57,55.74],[37.60,55.74],[37.60,55.76],[37.57,55.76],[37.57,55.74]]]}},
      { type:'Feature', properties:{name:'Пресненский'}, geometry:{type:'Polygon',coordinates:[[[37.55,55.755],[37.59,55.755],[37.59,55.775],[37.55,55.775],[37.55,55.755]]]}},
      { type:'Feature', properties:{name:'Тверской'}, geometry:{type:'Polygon',coordinates:[[[37.59,55.755],[37.63,55.755],[37.63,55.775],[37.59,55.775],[37.59,55.755]]]}},
      { type:'Feature', properties:{name:'Замоскворечье'}, geometry:{type:'Polygon',coordinates:[[[37.61,55.725],[37.65,55.725],[37.65,55.745],[37.61,55.745],[37.61,55.725]]]}},
      { type:'Feature', properties:{name:'Якиманка'}, geometry:{type:'Polygon',coordinates:[[[37.58,55.725],[37.62,55.725],[37.62,55.745],[37.58,55.745],[37.58,55.725]]]}},
      { type:'Feature', properties:{name:'Хамовники'}, geometry:{type:'Polygon',coordinates:[[[37.54,55.715],[37.60,55.715],[37.60,55.745],[37.54,55.745],[37.54,55.715]]]}},
      { type:'Feature', properties:{name:'Гагаринский'}, geometry:{type:'Polygon',coordinates:[[[37.52,55.68],[37.59,55.68],[37.59,55.72],[37.52,55.72],[37.52,55.68]]]}},
      { type:'Feature', properties:{name:'Дорогомилово'}, geometry:{type:'Polygon',coordinates:[[[37.49,55.73],[37.55,55.73],[37.55,55.755],[37.49,55.755],[37.49,55.73]]]}},
      { type:'Feature', properties:{name:'Измайлово'}, geometry:{type:'Polygon',coordinates:[[[37.76,55.77],[37.83,55.77],[37.83,55.81],[37.76,55.81],[37.76,55.77]]]}},
      { type:'Feature', properties:{name:'Сокольники'}, geometry:{type:'Polygon',coordinates:[[[37.66,55.78],[37.72,55.78],[37.72,55.82],[37.66,55.82],[37.66,55.78]]]}},
      { type:'Feature', properties:{name:'Даниловский'}, geometry:{type:'Polygon',coordinates:[[[37.61,55.705],[37.66,55.705],[37.66,55.73],[37.61,55.73],[37.61,55.705]]]}},
      { type:'Feature', properties:{name:'Таганский'}, geometry:{type:'Polygon',coordinates:[[[37.64,55.73],[37.69,55.73],[37.69,55.755],[37.64,55.755],[37.64,55.73]]]}},
    ]
  };
}

// =============================================
//  СТАРТ
// =============================================
initMap();
await loadVisited();
await loadGeoJSON();
