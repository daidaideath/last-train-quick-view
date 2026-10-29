#!/usr/bin/env node
// index.html の掲載データから、公式時刻表との再照合用チェックリスト（Markdown）を作る
// 使い方：リポジトリ直下で `node tools/make_checklist.js > docs/再照合チェックリスト_YYYYMMDD.md`
// 掲載値をそのまま並べるだけで、時刻の正誤は判定しない。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const literal = (name) => vm.runInNewContext(`(${html.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}]);`))[1]})`);
const stations = literal('stations');
const surveyDates = literal('surveyDates');

const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const cell = (h) => text(h).replace(/\|/g, '／');

// 章のHTMLを「見出し → 表」の並びに分解する
function tables(sectionHtml) {
  const out = [];
  let heading = '';
  const re = /<(h3|h4)>([\s\S]*?)<\/\1>|<table>([\s\S]*?)<\/table>/g;
  for (const m of sectionHtml.matchAll(re)) {
    if (m[1]) {
      heading = text(m[2]);
      continue;
    }
    const head = [...m[3].matchAll(/<th>([\s\S]*?)<\/th>/g)].map((x) => cell(x[1]));
    const rows = [...m[3].matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((r) => [...r[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((x) => cell(x[1])))
      .filter((r) => r.length);
    out.push({ heading, head, rows });
  }
  return out;
}

const lines = [];
const today = new Date();
const ymd = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
lines.push('# 終電時刻 再照合チェックリスト', '');
lines.push(`作成：${ymd}（tools/make_checklist.js で index.html から自動生成）`, '');
lines.push('- 各駅の「掲載値」は index.html に載っている値で、調査日時点のもの。');
lines.push('- 公式時刻表を開き、掲載値と一致すれば □ を ☑ にする。違えば「公式値」と確認日・出典を書き残す。');
lines.push('- 推測で埋めない。読めない・見つからない値は「未確認」と書く。');
lines.push('- 全駅の照合が終わったら index.html を直し、日付入りの新しい公開版を別名で作る（既存の公開版は上書きしない）。', '');
lines.push('## 一覧', '', '| 駅 | 調査日 | 出典URL数 | 照合結果 |', '|---|---|---|---|');
for (const s of stations) {
  const urls = new Set(s.sections.flatMap((x) => [...x.pages.join('').matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])));
  lines.push(`| ${s.name} | ${surveyDates[s.name] || '不明'} | ${urls.size} | 未照合 |`);
}
lines.push('');

for (const s of stations) {
  lines.push(`## ${s.name}（調査日 ${surveyDates[s.name] || '不明'}）`, '');
  lines.push('### 出典', '');
  const src = s.sections.find((x) => x.name === 'ソース').pages.join('');
  const items = [...src.matchAll(/<li>([\s\S]*?)<\/li>|href="(https?:\/\/[^"]+)"/g)];
  let label = '';
  for (const m of items) {
    if (m[1] !== undefined) label = text(m[1]);
    else {
      lines.push(`- [ ] ${label ? label + '：' : ''}${m[2].replace(/&amp;/g, '&')}`);
      label = '';
    }
  }
  lines.push('');
  for (const name of ['駅を出る最終列車', '駅に着く最終列車']) {
    const sec = s.sections.find((x) => x.name === name);
    const list = tables(sec.pages.join(''));
    if (!list.length) continue;
    lines.push(`### ${name}`, '');
    for (const t of list) {
      if (t.heading) lines.push(`**${t.heading}**`, '');
      lines.push(`| 確認 | ${t.head.join(' | ')} | 公式値（違う場合） |`);
      lines.push(`|---|${t.head.map(() => '---').join('|')}|---|`);
      for (const r of t.rows) lines.push(`| □ | ${r.join(' | ')} |  |`);
      lines.push('');
    }
  }
}
process.stdout.write(lines.join('\n') + '\n');
