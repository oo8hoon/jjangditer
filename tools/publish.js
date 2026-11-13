#!/usr/bin/env node
'use strict';
/**
 * 짱디터 배포 도우미
 *
 *   npm run release -- --notes "표 기능 추가"
 *   npm run release -- --notes "표 기능 추가" --to "\\\\파일서버\\공유\\짱디터"
 *
 * 하는 일
 *   1) dist 에서 이번 버전의 exe 를 찾는다
 *   2) latest.json 을 만든다 (직원들의 짱디터가 이 파일을 보고 새 버전을 안내함)
 *   3) --to 를 주면 그 폴더로 exe 와 latest.json 을 복사한다
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;

  if (!fs.existsSync(DIST)) {
    console.error('dist 폴더가 없습니다. 먼저 `npm run dist` 를 실행하세요.');
    process.exit(1);
  }

  // 이번 버전의 포터블 exe 찾기 (설치본은 이름에 "설치" 가 들어감)
  const candidates = fs.readdirSync(DIST)
    .filter((f) => f.toLowerCase().endsWith('.exe') && f.indexOf(version) >= 0)
    .sort((a, b) => (a.indexOf('설치') >= 0 ? 1 : 0) - (b.indexOf('설치') >= 0 ? 1 : 0));

  if (!candidates.length) {
    console.error('dist 에서 v' + version + ' exe 를 찾지 못했습니다. `npm run dist` 를 먼저 실행하세요.');
    process.exit(1);
  }

  const file = candidates[0];
  const full = path.join(DIST, file);
  const stat = fs.statSync(full);

  const info = {
    version: version,
    file: file,
    notes: arg('notes', ''),
    date: new Date().toISOString().slice(0, 10),
    size: stat.size,
    sha256: sha256(full)
  };

  const latest = path.join(DIST, 'latest.json');
  fs.writeFileSync(latest, JSON.stringify(info, null, 2), 'utf8');
  console.log('latest.json 생성');
  console.log('  버전 : ' + info.version);
  console.log('  파일 : ' + info.file + '  (' + (stat.size / 1048576).toFixed(1) + ' MB)');
  if (info.notes) console.log('  내용 : ' + info.notes);

  const to = arg('to', null);
  if (!to) {
    console.log('');
    console.log('배포하려면 아래 두 파일을 공유 폴더(또는 웹서버)에 올리세요:');
    console.log('  ' + full);
    console.log('  ' + latest);
    console.log('또는 --to "\\\\서버\\공유\\짱디터" 를 붙여 바로 복사하세요.');
    return;
  }

  try {
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(full, path.join(to, file));
    fs.copyFileSync(latest, path.join(to, 'latest.json'));
    console.log('');
    console.log('배포 완료 → ' + to);
    console.log('직원들의 짱디터가 6시간 안에(또는 ☰ → 업데이트 확인 시) 알림을 받습니다.');
  } catch (e) {
    console.error('복사 실패: ' + e.message);
    process.exit(1);
  }
}

main();
