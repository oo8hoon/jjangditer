#!/usr/bin/env node
'use strict';
/**
 * 짱디터 빌드 — 윈도우에 기본 포함된 C# 컴파일러로 단일 exe 를 만든다.
 * 설치해야 하는 개발 도구가 없다.
 *
 *   node tools/build.js
 *
 * 하는 일
 *   1) WebView2 SDK(DLL 3개)가 없으면 nuget 에서 받아둔다 (설치가 아니라 파일만)
 *   2) 화면 파일(src/*)을 web.zip 으로 묶는다
 *   3) csc.exe 로 컴파일하며 DLL·web.zip·아이콘을 exe 안에 넣는다
 *   4) dist 에 이번 버전 exe 만 남긴다
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(ROOT, 'host');
const LIB = path.join(HOST, 'lib');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

const WV2_VERSION = '1.0.3485.44';
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const CSC = path.join(process.env.WINDIR || 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function log(m) { console.log(m); }
function ps(script) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
}

/* 1) WebView2 SDK 확보 ---------------------------------------------------- */
const NEED = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];

function ensureSdk() {
  fs.mkdirSync(LIB, { recursive: true });
  if (NEED.every((f) => fs.existsSync(path.join(LIB, f)))) {
    log('WebView2 SDK : 이미 있음');
    return;
  }
  log('WebView2 SDK 내려받는 중… (설치 아님, DLL 파일만)');
  const tmp = path.join(os.tmpdir(), 'jj-wv2-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'wv2.zip');
  ps(`$ProgressPreference='SilentlyContinue';` +
    `Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WV2_VERSION}' ` +
    `-OutFile '${zip}' -UseBasicParsing; ` +
    `Expand-Archive -Path '${zip}' -DestinationPath '${tmp}\\pkg' -Force`);

  const pick = [
    [path.join(tmp, 'pkg', 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll'), 'Microsoft.Web.WebView2.Core.dll'],
    [path.join(tmp, 'pkg', 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll'), 'Microsoft.Web.WebView2.WinForms.dll'],
    [path.join(tmp, 'pkg', 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'), 'WebView2Loader.dll']
  ];
  for (const [from, to] of pick) {
    if (!fs.existsSync(from)) throw new Error('SDK 안에서 못 찾음: ' + from);
    fs.copyFileSync(from, path.join(LIB, to));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  log('WebView2 SDK : 준비 완료');
}

/* 2) 화면 파일 묶기 -------------------------------------------------------- */
function packWeb() {
  fs.mkdirSync(BUILD, { recursive: true });
  const zip = path.join(BUILD, 'web.zip');
  try { if (fs.existsSync(zip)) fs.unlinkSync(zip); } catch (e) { /* 덮어쓰기로 처리됨 */ }

  // 백신이 방금 만든 폴더를 잠시 잡고 있는 경우가 있어 매번 새 이름을 쓴다
  const stage = path.join(BUILD, 'webstage-' + Date.now());
  fs.mkdirSync(stage, { recursive: true });

  let n = 0;
  for (const f of fs.readdirSync(SRC)) {
    // trigger.html/js 는 WebView2 판에서 쓰지 않는다 (띠를 C# 으로 직접 그림)
    if (f === 'trigger.html' || f === 'trigger.js') continue;
    fs.copyFileSync(path.join(SRC, f), path.join(stage, f));
    n++;
  }

  ps(`Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`);

  // 이번 것과 예전에 남은 staging 폴더 정리 (실패해도 그냥 넘어간다)
  for (const d of fs.readdirSync(BUILD)) {
    if (d.indexOf('webstage') !== 0) continue;
    try { fs.rmSync(path.join(BUILD, d), { recursive: true, force: true }); } catch (e) { }
  }

  log(`화면 파일 ${n}개 → web.zip (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
  return zip;
}

/* 3) 컴파일 ---------------------------------------------------------------- */
function writeAssemblyInfo() {
  const f = path.join(BUILD, 'AssemblyInfo.cs');
  const v4 = VERSION.split('.').slice(0, 3).concat(['0']).join('.');
  fs.writeFileSync(f,
    '// 빌드할 때 자동 생성됩니다\n' +
    'using System.Reflection;\n' +
    `[assembly: AssemblyTitle("짱디터")]\n` +
    `[assembly: AssemblyProduct("JJangditer")]\n` +
    `[assembly: AssemblyCompany("Jjangs")]\n` +
    `[assembly: AssemblyDescription("서버 설치 체크리스트용 우측 도킹 사이드 에디터")]\n` +
    `[assembly: AssemblyVersion("${v4}")]\n` +
    `[assembly: AssemblyFileVersion("${v4}")]\n` +
    `[assembly: AssemblyInformationalVersion("${VERSION}")]\n`, 'utf8');
  return f;
}

function compile(webZip) {
  fs.mkdirSync(DIST, { recursive: true });
  // JJ_OUT 을 주면 그 자리에 만든다 (쓰고 있는 exe 를 건드리지 않고 시험할 때)
  const out = process.env.JJ_OUT || path.join(DIST, `짱디터-${VERSION}.exe`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const icon = path.join(BUILD, 'icon.ico');
  const args = [
    '-nologo', '-target:winexe', '-platform:x64', '-optimize+', '-warn:1',
    `-out:${out}`,
    `-win32icon:${icon}`,
    `-reference:${path.join(LIB, 'Microsoft.Web.WebView2.Core.dll')}`,
    `-reference:${path.join(LIB, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '-reference:System.Web.Extensions.dll',
    '-reference:System.IO.Compression.dll',
    '-reference:System.IO.Compression.FileSystem.dll',
    // exe 안에 넣을 것들
    `-resource:${path.join(LIB, 'Microsoft.Web.WebView2.Core.dll')},Microsoft.Web.WebView2.Core.dll`,
    `-resource:${path.join(LIB, 'Microsoft.Web.WebView2.WinForms.dll')},Microsoft.Web.WebView2.WinForms.dll`,
    `-resource:${path.join(LIB, 'WebView2Loader.dll')},WebView2Loader.dll`,
    `-resource:${webZip},web.zip`,
    `-resource:${icon},icon.ico`,
    writeAssemblyInfo(),
    path.join(HOST, 'JJangditer.cs'),
    path.join(HOST, 'AppContext.cs')
  ];
  log('컴파일 중…');
  try {
    const o = execFileSync(CSC, args, { encoding: 'utf8', cwd: ROOT });
    if (o.trim()) console.log(o.trim());
  } catch (e) {
    console.error(e.stdout || e.message);
    process.exit(1);
  }
  return out;
}

/* 4) 정리 ------------------------------------------------------------------ */
function clean(keep) {
  for (const n of fs.readdirSync(DIST)) {
    const full = path.join(DIST, n);
    if (full === keep || n === 'latest.json') continue;
    try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { }
  }
}

function main() {
  if (!fs.existsSync(CSC)) {
    console.error('C# 컴파일러를 찾지 못했습니다: ' + CSC);
    process.exit(1);
  }
  ensureSdk();
  const zip = packWeb();
  const out = compile(zip);
  if (!process.env.JJ_OUT) clean(out);   // 시험용 빌드는 dist 를 건드리지 않는다
  const kb = fs.statSync(out).size / 1024;
  log('');
  log('빌드 완료');
  log('   ' + out);
  log('   ' + (kb > 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB'));
  log('');
  log('직원에게는 이 exe 파일 하나만 주면 됩니다.');
}

main();
