#!/usr/bin/env node
'use strict';
/**
 * 빌드가 끝난 뒤 dist 폴더를 정리한다.
 * 직원에게 줄 파일(exe)과 배포용 latest.json 만 남기고 나머지 부산물은 지운다.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

if (!fs.existsSync(DIST)) process.exit(0);

let removed = 0;
for (const name of fs.readdirSync(DIST)) {
  const full = path.join(DIST, name);
  const st = fs.statSync(full);
  const ext = path.extname(name).toLowerCase();
  // 이번 버전의 exe 와 배포용 latest.json 만 남긴다 (옛 버전 exe 는 헷갈리므로 삭제)
  const keep = st.isFile() &&
    ((ext === '.exe' && name.indexOf(VERSION) >= 0 && name.indexOf('설치') < 0) ||
      name === 'latest.json');
  if (keep) continue;
  try {
    fs.rmSync(full, { recursive: true, force: true });
    removed++;
  } catch (e) {
    console.warn('지우지 못함: ' + name + ' (' + e.message + ')');
  }
}

const left = fs.readdirSync(DIST);
console.log('');
console.log('dist 정리 완료 (부산물 ' + removed + '개 삭제)');
console.log('직원에게 줄 파일:');
for (const n of left) {
  const sz = fs.statSync(path.join(DIST, n)).size;
  console.log('   ' + n + '   (' + (sz / 1048576).toFixed(1) + ' MB)');
}
