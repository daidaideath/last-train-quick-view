#!/usr/bin/env node
// 終電クイックビューのデータ点検スクリプト（依存パッケージなし）
// 使い方：リポジトリ直下で `node tools/check_data.js`
//   --online を付けると出典URLへの到達確認も行う（ネットワーク接続が必要）
// 時刻の正しさそのものは判定しない。形の崩れ・リンク切れ・駅の不揃いを見つけるためのもの。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// HTML内の `const <name> = [...] / {...};` を取り出して評価する
function extractLiteral(html, name, file) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}]);\\s*(?:\\n|const |function |let |renderStationNav|$)`);
  const m = html.match(re);
  if (!m) {
    err(file, `${name} が見つからない`);
    return null;
  }
  try {
    return vm.runInNewContext(`(${m[1]})`, {}, { timeout: 1000 });
  } catch (e) {
    err(file, `${name} を読み取れない（${e.message}）`);
    return null;
  }
}

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ');

// 0:31、23:54、1:00 のような時刻表記の範囲チェック（24時以降表記も許容）
function checkTimes(text, where) {
  for (const m of text.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 29 || min > 59) err(where, `時刻表記が不正：${m[0]}`);
  }
}

// ---------- index.html ----------
const indexFile = 'index.html';
const indexHtml = read(indexFile);
const stations = extractLiteral(indexHtml, 'stations', indexFile) || [];
const sectionNames = extractLiteral(indexHtml, 'sectionNames', indexFile) || [];
const surveyDates = extractLiteral(indexHtml, 'surveyDates', indexFile) || {};
const terminusRowIndexes = extractLiteral(indexHtml, 'terminusRowIndexes', indexFile) || {};
const allUrls = new Map();

const seen = new Set();
stations.forEach((s, i) => {
  const where = `${indexFile} [${i}] ${s.name || '(名前なし)'}`;
  if (!s.name) err(where, 'name がない');
  if (seen.has(s.name)) err(where, '駅名が重複');
  seen.add(s.name);
  const names = (s.sections || []).map((x) => x.name);
  if (JSON.stringify(names) !== JSON.stringify(sectionNames)) {
    err(where, `章の構成が sectionNames と一致しない（${names.join('、')}）`);
  }
  for (const sec of s.sections || []) {
    if (!Array.isArray(sec.pages) || !sec.pages.length || !sec.pages.join('').trim()) {
      err(where, `「${sec.name}」が空`);
      continue;
    }
    const html = sec.pages.join('');
    checkTimes(stripTags(html), `${where}「${sec.name}」`);
    for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      const url = m[1].replace(/&amp;/g, '&');
      if (!allUrls.has(url)) allUrls.set(url, new Set());
      allUrls.get(url).add(s.name);
    }
  }
  const src = (s.sections || []).find((x) => x.name === 'ソース');
  if (src && !/href="https?:\/\//.test(src.pages.join(''))) err(where, 'ソースに出典URLがない');

  const iso = surveyDates[s.name];
  if (!iso) err(where, 'surveyDates に調査日がない');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) err(where, `調査日の形式が不正：${iso}`);
});
for (const name of Object.keys(surveyDates)) {
  if (!seen.has(name)) err(indexFile, `surveyDates に stations にない駅：${name}`);
}

// 「終」アイコン対象行が「駅に着く最終列車」の表の行数内にあるか
for (const [name, rows] of Object.entries(terminusRowIndexes)) {
  const s = stations.find((x) => x.name === name);
  if (!s) {
    err(indexFile, `terminusRowIndexes に stations にない駅：${name}`);
    continue;
  }
  const sec = s.sections.find((x) => x.name === '駅に着く最終列車');
  const html = sec ? sec.pages.join('') : '';
  const rowCount = (html.match(/<tbody>[\s\S]*?<\/tbody>/g) || [])
    .reduce((n, body) => n + (body.match(/<tr>/g) || []).length, 0);
  for (const r of rows) {
    if (r >= rowCount) err(`${indexFile} ${name}`, `「終」対象の行番号 ${r} が表の行数 ${rowCount} を超える`);
  }
}

// ---------- 公開版・詳細ビジュアル版 ----------
const summaryFields = ['name', 'route', 'date', 'recommended', 'focus', 'last', 'sort', 'file', 'lead', 'events'];
const publicPattern = /^駅別終電クイックビュー_公開版_\d{8}(?:_[^/\\]+)?\.html$/;
const publicFiles = [
  ...fs.readdirSync(root).filter((f) => publicPattern.test(f)),
  ...(fs.existsSync(path.join(root, 'output')) ? fs.readdirSync(path.join(root, 'output'))
    .filter((f) => publicPattern.test(f)).map((f) => `output/${f}`) : []),
].sort();
const summaryFiles = [...publicFiles, 'index_detail_visual.html'];
const summaries = {};

for (const file of summaryFiles) {
  const list = extractLiteral(read(file), 'stations', file) || [];
  summaries[file] = list;
  const names = new Set();
  list.forEach((s, i) => {
    const where = `${file} [${i}] ${s.name || '(名前なし)'}`;
    for (const f of summaryFields) {
      if (s[f] === undefined || s[f] === '') err(where, `${f} がない`);
    }
    if (names.has(s.name)) err(where, '駅名が重複');
    names.add(s.name);
    if (s.date && !/^\d{4}年\d{1,2}月\d{1,2}日$/.test(s.date)) err(where, `date の形式が不正：${s.date}`);
    if (s.file && !fs.existsSync(path.join(root, path.dirname(file), s.file))) err(where, `リンク先ファイルがない：${s.file}`);
    if (!Array.isArray(s.events) || !s.events.length) err(where, 'events が空');
    else s.events.forEach((e) => checkTimes(String(e[0]), where));
    checkTimes([s.recommended, s.focus, s.last].join(' '), where);
    if (!seen.has(s.name)) warn(where, 'index.html にない駅');
    else if (surveyDates[s.name]) {
      const [y, m, d] = surveyDates[s.name].split('-').map(Number);
      if (s.date !== `${y}年${m}月${d}日`) warn(where, `調査日が index.html（${surveyDates[s.name]}）と異なる：${s.date}`);
    }
  });
}

// ---------- 駅の揃い ----------
const reportDir = path.join(root, 'reports_business');
const reportStations = new Set(fs.readdirSync(reportDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/（.*?）/, '').replace(/終電調査レポート.*$/, '')));
const visualCount = (summaries['index_detail_visual.html'] || []).length;
for (const name of seen) {
  if (!reportStations.has(name)) warn('reports_business', `${name} のレポートがない`);
  const inVisual = (summaries['index_detail_visual.html'] || []).some((s) => s.name === name);
  if (!inVisual) warn('index_detail_visual.html', `${name} の詳細画像がない`);
}

// ---------- 出典URLの到達確認（任意） ----------
async function checkOnline() {
  const results = [];
  for (const [url, names] of allUrls) {
    let status;
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      status = res.status;
    } catch (e) {
      status = e.cause?.code || e.name;
    }
    results.push([status, url, [...names].join('、')]);
    if (status !== 200) warn('出典URL', `${status} ${url}（${[...names].join('、')}）`);
  }
  return results;
}

(async () => {
  if (process.argv.includes('--online')) await checkOnline();
  console.log(`index.html：${stations.length}駅、出典URL ${allUrls.size}件`);
  for (const file of summaryFiles) console.log(`${file}：${(summaries[file] || []).length}駅`);
  console.log(`reports_business：${reportStations.size}駅、詳細画像：${visualCount}駅`);
  if (warnings.length) {
    console.log(`\n注意 ${warnings.length}件`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (errors.length) {
    console.log(`\nエラー ${errors.length}件`);
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nエラーなし');
})();
