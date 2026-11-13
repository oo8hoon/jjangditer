#!/usr/bin/env node
'use strict';
/**
 * 내장 템플릿을 짱디터 탭 파일(.jjt)로 뽑아낸다.
 * 빌드하지 않고도 ☰ → 파일 불러오기 로 바로 쓸 수 있고, 동료에게 전달할 수도 있다.
 *
 *   node tools/export-template.js                 # 전체 목록 보기
 *   node tools/export-template.js dr-recovery     # templates/ 폴더에 저장
 *   node tools/export-template.js dr-recovery "D:\\공유\\DR훈련.jjt"
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

global.window = {};
require(path.join(ROOT, 'src', 'templates.js'));
const list = global.window.JJ_TEMPLATES || [];

const id = process.argv[2];
if (!id) {
  console.log('사용할 수 있는 템플릿:');
  for (const t of list) console.log('  ' + t.id.padEnd(16) + t.name + '  (' + t.rows.length + '행)');
  console.log('');
  console.log('예) node tools/export-template.js ' + (list[0] ? list[0].id : 'blank'));
  process.exit(0);
}

const tpl = list.find((t) => t.id === id);
if (!tpl) {
  console.error('그런 템플릿이 없습니다: ' + id);
  process.exit(1);
}

const payload = {
  kind: 'jjangditer-tab',
  version: 1,
  exportedAt: new Date().toISOString(),
  tab: { name: tpl.tabName || tpl.name, rows: tpl.rows }
};

let out = process.argv[3];
if (!out) {
  const dir = path.join(ROOT, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  out = path.join(dir, (tpl.tabName || tpl.id) + '.jjt');
}

fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

const count = {};
for (const r of tpl.rows) count[r.type] = (count[r.type] || 0) + 1;
console.log('저장: ' + out);
console.log('  ' + tpl.name + ' — ' + tpl.rows.length + '행 ' +
  '(섹션 ' + (count.section || 0) + ', 항목 ' + (count.item || 0) +
  ', 명령 ' + (count.cmd || 0) + ', 표 ' + (count.table || 0) + ')');
