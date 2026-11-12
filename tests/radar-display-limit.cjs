// Radar の表示上限 (radarSelectPlotPoints) の検証。
// - 上限以下なら全件、上限ありなら件数を抑える
// - 選択中の曲/周辺曲は必ず残る
// - クラスタが偏らず、両方の領域から選ばれる
// - ズームインで表示点数が増える (focus+context)
// - 同じ入力なら同じ点が選ばれる (ちらつき防止)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('frontend/app.js', 'utf8');
const start = source.indexOf('export function radarSelectPlotPoints');
const end = source.indexOf('/** マップの表示上限を変更する', start);
assert.ok(start > 0 && end > start, 'radarSelectPlotPoints を抽出できません');
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, end).replace(/^export /gm, ''), ctx);
const select = ctx.radarSelectPlotPoints;

const point = (id, x, y) => ({ t: { youtube_id: id, features: { x, y } }, px: x * 1000, py: y * 1000 });

// 2クラスタ (左上/右下) に分かれた100曲
const points = [];
for (let i = 0; i < 50; i++) points.push(point(`a${i}`, 0.05 + (i % 10) * 0.02, 0.05 + Math.floor(i / 10) * 0.03));
for (let i = 0; i < 50; i++) points.push(point(`b${i}`, 0.65 + (i % 10) * 0.02, 0.65 + Math.floor(i / 10) * 0.03));

assert.equal(select(points, { limit: 0 }).length, 100, '0 は全件');
assert.equal(select(points, { limit: 200 }).length, 100, '上限が総数以上なら全件');

const capped = select(points, { limit: 20, zoom: 1 });
assert.equal(capped.length, 20, '上限どおりに間引く');
assert.ok(capped.some(p => p.t.features.x < 0.5), '左クラスタから選ぶ');
assert.ok(capped.some(p => p.t.features.x > 0.5), '右クラスタから選ぶ');

const withRequired = select(points, { limit: 10, zoom: 1, requiredIds: ['a0', 'b0'] });
assert.ok(withRequired.some(p => p.t.youtube_id === 'a0'), '選択中の曲は必ず残す');
assert.ok(withRequired.some(p => p.t.youtube_id === 'b0'), '周辺曲も必ず残す');
assert.ok(withRequired.length >= 10, '必須点を含めても上限以上');

const zoomed = select(points, { limit: 20, zoom: 4 });
assert.ok(zoomed.length > capped.length, 'ズームインで表示点数が増える');
assert.equal(zoomed.length, 40, 'ズーム4倍で上限の2倍まで増える');

const first = select(points, { limit: 20, zoom: 1 }).map(p => p.t.youtube_id).join(',');
const second = select(points, { limit: 20, zoom: 1 }).map(p => p.t.youtube_id).join(',');
assert.equal(first, second, '同じ入力なら同じ点を選ぶ (ちらつかない)');

// 座標がない点は中央付近の代表として扱い、落ちない
const noCoords = Array.from({ length: 40 }, (_, i) => ({ t: { youtube_id: `x${i}`, features: {} }, px: 0, py: 0 }));
assert.equal(select(noCoords, { limit: 12 }).length, 12, '座標なしでも上限どおり');
assert.equal(select([], { limit: 12 }).length, 0, '空配列');

console.log('PASS: Radar の表示上限は分布を保って間引き、選択曲を残し、ズームで詳細を増やす。');
