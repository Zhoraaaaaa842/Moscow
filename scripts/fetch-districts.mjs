/**
 * Скачивает реальные границы всех районов Москвы через Nominatim OSM API
 * и сохраняет в public/moscow-districts.geojson
 * Имена районов берутся прямо из src/districts.js (~125 шт.)
 * Nominatim: 1 req/s → ~2.5 мин
 */

import { DISTRICTS_META } from '../src/districts.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'public', 'moscow-districts.geojson');

const NAMES = Object.keys(DISTRICTS_META);

// Некоторые районы в OSM/Nominatim называются чуть иначе
const SEARCH_OVERRIDES = {
  'Ломоносовский':              'район Ломоносовский Москва',
  'Тёплый Стан':                'муниципальный округ Тёплый Стан Москва',
  'Черёмушки':                  'район Черёмушки Москва',
  'Хорошёво-Мнёвники':         'район Хорошёво-Мнёвники Москва',
  'Москворечье-Сабурово':       'район Москворечье-Сабурово Москва',
  'Орехово-Борисово Северное':  'район Орехово-Борисово Северное Москва',
  'Орехово-Борисово Южное':     'район Орехово-Борисово Южное Москва',
  'Нагатино-Садовники':         'район Нагатино-Садовники Москва',
  'Выхино-Жулебино':            'район Выхино-Жулебино Москва',
  'Косино-Ухтомский':           'район Косино-Ухтомский Москва',
  'Восточное Дегунино':         'район Восточное Дегунино Москва',
  'Западное Дегунино':          'район Западное Дегунино Москва',
  'Восточное Измайлово':        'район Восточное Измайлово Москва',
  'Северное Измайлово':         'район Северное Измайлово Москва',
  'Северное Медведково':        'район Северное Медведково Москва',
  'Южное Медведково':           'район Южное Медведково Москва',
  'Северное Бутово':            'район Северное Бутово Москва',
  'Южное Бутово':               'район Южное Бутово Москва',
  'Северное Тушино':            'район Северное Тушино Москва',
  'Южное Тушино':               'район Южное Тушино Москва',
  'Покровское-Стрешнево':       'район Покровское-Стрешнево Москва',
  'Ново-Переделкино':           'район Ново-Переделкино Москва',
  'Тропарёво-Никулино':         'район Тропарёво-Никулино Москва',
  'Очаково-Матвеевское':        'район Очаково-Матвеевское Москва',
  'Проспект Вернадского':       'район Проспект Вернадского Москва',
  'Нагатинский Затон':          'район Нагатинский Затон Москва',
  'Филёвский Парк':             'район Филёвский Парк Москва',
  'Фили-Давыдково':             'район Фили-Давыдково Москва',
  'Марьина Роща':               'район Марьина Роща Москва',
  'Соколиная Гора':             'район Соколиная Гора Москва',
  'Бирюлёво Восточное':         'район Бирюлёво Восточное Москва',
  'Бирюлёво Западное':          'район Бирюлёво Западное Москва',
  'Чертаново Северное':         'район Чертаново Северное Москва',
  'Чертаново Центральное':      'район Чертаново Центральное Москва',
  'Чертаново Южное':            'район Чертаново Южное Москва',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchDistrict(name) {
  const query = SEARCH_OVERRIDES[name] || `район ${name} Москва`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=geojson&polygon_geojson=1&limit=5&countrycodes=ru`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'MoscowWalkApp/1.0 (github.com/Zhoraaaaaa842/Moscow)',
      'Accept-Language': 'ru,en',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (!data.features?.length) return null;

  // Предпочитаем relation с типом boundary/suburb/district
  const ranked = data.features
    .filter(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
    .sort((a, b) => {
      const score = f => {
        const t = f.properties?.type || '';
        const cls = f.properties?.class || '';
        if (cls === 'boundary' && t === 'administrative') return 0;
        if (cls === 'place' && (t === 'suburb' || t === 'neighbourhood' || t === 'quarter')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

  return ranked[0] || null;
}

async function main() {
  console.log(`Скачиваем ${NAMES.length} районов через Nominatim (~${Math.ceil(NAMES.length * 1.1 / 60)} мин)...`);
  const features = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i];
    process.stdout.write(`[${String(i + 1).padStart(3)}/${NAMES.length}] ${name.padEnd(35)} `);
    try {
      const feature = await fetchDistrict(name);
      if (feature) {
        features.push({ type: 'Feature', properties: { name }, geometry: feature.geometry });
        process.stdout.write(`✓ (${feature.geometry.type})\n`);
        ok++;
      } else {
        process.stdout.write(`— не найдено\n`);
        fail++;
      }
    } catch (e) {
      process.stdout.write(`✗ ${e.message}\n`);
      fail++;
    }
    if (i < NAMES.length - 1) await sleep(1100);
  }

  console.log(`\n✓ ${ok} найдено, ${fail} не найдено`);
  const geojson = { type: 'FeatureCollection', features };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(geojson));
  console.log(`✓ Сохранено: ${OUT_PATH} (${(JSON.stringify(geojson).length / 1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
