/**
 * Доскачивает оставшиеся районы с альтернативными поисковыми запросами
 * и добавляет их в существующий public/moscow-districts.geojson
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'public', 'moscow-districts.geojson');

// Альтернативные запросы для проблемных районов
// Ключ — название в DISTRICTS_META, значение — список запросов для Nominatim
const ALTERNATIVES = {
  'Таганский':           ['район Таганский Москва administrativeboundary', 'Таганский район Москва'],
  'Войковский':          ['муниципальный округ Войковский Москва', 'Войковский Москва район'],
  'Дмитровский':         ['муниципальный округ Дмитровский Москва', 'Дмитровский район Москва'],
  'Молжаниновский':      ['Молжаниновский Москва', 'поселение Молжаниновское Москва'],
  'Савёловский':         ['муниципальный округ Савёловский Москва', 'Савёловский Москва'],
  'Ховрино':             ['район Ховрино Москва', 'Ховрино Москва'],
  'Алтуфьевский':        ['муниципальный округ Алтуфьевский Москва', 'Алтуфьевский район Москва'],
  'Бабушкинский':        ['муниципальный округ Бабушкинский Москва', 'Бабушкинский район Москва'],
  'Бутырский':           ['муниципальный округ Бутырский Москва', 'Бутырский район Москва'],
  'Лосиноостровский':    ['муниципальный округ Лосиноостровский Москва', 'Лосиноостровский Москва'],
  'Марфино':             ['район Марфино Москва', 'Марфино Москва'],
  'Отрадное':            ['район Отрадное Москва', 'Отрадное Москва'],
  'Ярославский':         ['район Ярославский Москва', 'Ярославский Москва'],
  'Восточный':           ['поселение Восточный Москва', 'Восточный Москва'],
  'Новогиреево':         ['район Новогиреево Москва', 'Новогиреево Москва'],
  'Южное Измайлово':     ['район Южное Измайлово Москва', 'Южное Измайлово Москва'],
  'Рязанский':           ['муниципальный округ Рязанский Москва', 'Рязанский район Москва'],
  'Южнопортовый':        ['муниципальный округ Южнопортовый Москва', 'Южнопортовый Москва'],
  'Даниловский':         ['муниципальный округ Даниловский Москва', 'Даниловский район Москва'],
  'Донской':             ['муниципальный округ Донской Москва', 'Донской район Москва'],
  'Нагорный':            ['муниципальный округ Нагорный Москва', 'Нагорный район Москва'],
  'Академический':       ['муниципальный округ Академический Москва', 'Академический район Москва'],
  'Ломоносовский':       ['муниципальный округ Ломоносовский Москва', 'Ломоносовский район Москва'],
  'Тропарёво-Никулино':  ['Тропарёво-Никулино Москва', 'район Тропарево Никулино Москва'],
  'Северное Бутово':     ['район Северное Бутово Москва', 'Северное Бутово Москва'],
  'Можайский':           ['муниципальный округ Можайский Москва', 'Можайский район Москва'],
  'Ново-Переделкино':    ['Ново-Переделкино Москва', 'район Новопеределкино Москва'],
  'Куркино':             ['район Куркино Москва', 'Куркино Москва'],
  'Лианозово':           ['район Лианозово Москва', 'Лианозово Москва'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tryNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=geojson&polygon_geojson=1&limit=3&countrycodes=ru`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'MoscowWalkApp/1.0 (github.com/Zhoraaaaaa842/Moscow)',
      'Accept-Language': 'ru,en',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || []).find(f =>
    f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
  ) || null;
}

async function main() {
  const geojson = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const existing = new Set(geojson.features.map(f => f.properties.name));

  const missing = Object.keys(ALTERNATIVES).filter(n => !existing.has(n));
  console.log(`Уже есть: ${existing.size}. Недостаёт: ${missing.length}`);
  if (!missing.length) { console.log('Все районы уже скачаны!'); return; }

  let added = 0;
  for (const name of missing) {
    const queries = ALTERNATIVES[name];
    let found = null;
    for (const q of queries) {
      process.stdout.write(`  ${name}: "${q}"... `);
      try {
        found = await tryNominatim(q);
        if (found) { process.stdout.write(`✓ (${found.geometry.type})\n`); break; }
        else process.stdout.write(`—\n`);
      } catch (e) {
        process.stdout.write(`✗ ${e.message}\n`);
      }
      await sleep(1100);
    }
    if (found) {
      geojson.features.push({ type: 'Feature', properties: { name }, geometry: found.geometry });
      added++;
    } else {
      console.log(`  ✗ ${name}: не нашлось ни по одному запросу`);
    }
    await sleep(1100);
  }

  writeFileSync(OUT_PATH, JSON.stringify(geojson));
  console.log(`\n✓ Добавлено ${added} районов. Итого: ${geojson.features.length}`);
  console.log(`✓ Файл: ${OUT_PATH} (${(JSON.stringify(geojson).length / 1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
