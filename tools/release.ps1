<#
    짱디터 릴리스 — 한 번에 실행

    사용법
      .\tools\release.ps1 -Notes "바뀐 내용"              # 패치 버전 +1 (1.3.2 -> 1.3.3)
      .\tools\release.ps1 -Version 1.4.0 -Notes "..."     # 버전 직접 지정
      .\tools\release.ps1 -ReleaseOnly                    # 이미 빌드·커밋된 것을 릴리스만
      .\tools\release.ps1 -Delete v1.3.0                  # 릴리스 삭제
      .\tools\release.ps1 -Notes "..." -WhatIfOnly        # 올리지 않고 점검만

    하는 일
      1) 버전 올리기        2) 빌드        3) 릴리스용 묶음 만들기
      4) 내부정보 유출 검사  5) 커밋·태그·푸시
      6) GitHub 릴리스 생성 + 파일 올리기
      7) 공개된 주소로 실제 내려받아 확인

    인증
      git 이 쓰는 자격증명(Windows 자격 증명 관리자)을 그대로 빌려 씁니다.
      따로 토큰을 만들 필요가 없고, 화면에도 출력하지 않습니다.
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $Notes = '',
    [switch] $ReleaseOnly,
    [string] $Delete,
    [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($n, $t) { Write-Host ("`n[{0}] {1}" -f $n, $t) -ForegroundColor Cyan }
function Good($t) { Write-Host ("    OK  " + $t) -ForegroundColor Green }
function Warn($t) { Write-Host ("    !!  " + $t) -ForegroundColor Yellow }
function Die($t) { Write-Host ("`n중단: " + $t) -ForegroundColor Red; exit 1 }

# git 은 정상 메시지도 stderr 로 내보낸다.
# PowerShell 5.1 은 그걸 오류로 보므로, 여기서만 잠시 멈추지 않게 한다.
function GitQ {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git.exe @GitArgs 2>&1
        return @{ code = $LASTEXITCODE; out = ($out | Out-String) }
    } finally {
        $ErrorActionPreference = $prev
    }
}

# ──────────────────────────────────────────────────────────── 저장소 정보
$url = $null
try { $url = (& git.exe remote get-url origin) | Select-Object -First 1 } catch { }
if (-not $url) { Die 'origin 원격이 없습니다.' }
if ($url -notmatch 'github\.com[/:]([^/]+)/([^/.]+)') { Die "GitHub 주소가 아닙니다: $url" }
$Owner = $Matches[1]; $Repo = $Matches[2]

# ──────────────────────────────────────────────────────────── 인증 (git 에게 물어봄)
function Get-GitHubToken {
    # 임시 파일로 넘긴다. 파이프는 실행 환경에 따라 stdin 이 막혀 있을 수 있다.
    $tmp = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n", (New-Object Text.ASCIIEncoding))
        $out = cmd /c "git credential fill < `"$tmp`"" 2>$null
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
    foreach ($line in $out) { if ($line -like 'password=*') { return $line.Substring(9) } }
    return $null
}
function Api($method, $uri, $body) {
    $h = @{
        Authorization          = "Bearer $script:Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'jjangditer-release'
    }
    if ($body) {
        return Invoke-RestMethod -Uri $uri -Method $method -Headers $h -ContentType 'application/json' `
            -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5)))
    }
    return Invoke-RestMethod -Uri $uri -Method $method -Headers $h
}

$script:Token = Get-GitHubToken
if (-not $script:Token) {
    Die @'
GitHub 자격증명을 찾지 못했습니다.
먼저 아무 명령이나 한 번 실행해서 로그인해 주세요:
    git push
브라우저 로그인 창이 뜨고, 그 뒤로는 이 스크립트가 자동으로 씁니다.
'@
}
Good "저장소 $Owner/$Repo · 인증 확인됨"

# ──────────────────────────────────────────────────────────── 릴리스 삭제 모드
if ($Delete) {
    Step 1 "릴리스 삭제: $Delete"
    try {
        $rel = Api GET "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Delete"
    } catch { Die "$Delete 릴리스를 찾지 못했습니다." }
    Api DELETE "https://api.github.com/repos/$Owner/$Repo/releases/$($rel.id)" | Out-Null
    Good "릴리스 $Delete 삭제됨 (태그는 그대로 남습니다)"
    exit 0
}

# ──────────────────────────────────────────────────────────── 1) 버전
$pkgPath = Join-Path $Root 'package.json'
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cur = $pkg.version

if ($ReleaseOnly) {
    $Version = $cur
    Step 1 "버전 (그대로 사용): $Version"
} else {
    if (-not $Version) {
        $p = $cur.Split('.')
        $Version = "{0}.{1}.{2}" -f $p[0], $p[1], ([int]$p[2] + 1)
    }
    Step 1 "버전: $cur  ->  $Version"
    if (-not $Notes) { Warn '변경 내용(-Notes)이 비어 있습니다.' }

    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) { Warn "작업트리에 변경 $($dirty.Count)건 — 함께 커밋됩니다" }

    # JSON 을 통째로 다시 쓰지 않고 버전 문자열만 바꾼다.
    # (Set-Content 는 BOM 을 붙이고, 그러면 node 의 JSON.parse 가 실패한다)
    $txt = [IO.File]::ReadAllText($pkgPath)
    $txt = [regex]::Replace($txt, '"version"\s*:\s*"[^"]+"', '"version": "' + $Version + '"', 1)
    [IO.File]::WriteAllText($pkgPath, $txt, (New-Object Text.UTF8Encoding $false))
    Good 'package.json 갱신'
}
$Tag = "v$Version"

# ──────────────────────────────────────────────────────────── 2~3) 빌드 + 묶음
if (-not $ReleaseOnly) {
    Step 2 '빌드'
    Get-Process | Where-Object { $_.ProcessName -like '*디터*' -or $_.ProcessName -like 'JJangditer*' } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    node tools/build.js | Out-Null
    if ($LASTEXITCODE -ne 0) { Die '빌드 실패' }
    Good "빌드 완료 ($Version)"

    Step 3 '릴리스용 묶음'
    node tools/publish.js --notes $Notes --gh | Out-Null
    if ($LASTEXITCODE -ne 0) { Die '묶음 생성 실패' }
}

$relDir = Join-Path $Root 'dist\release'
$exe = Join-Path $relDir "JJangditer-$Version.exe"
$json = Join-Path $relDir 'latest.json'
if (-not (Test-Path $exe)) { Die "릴리스 파일이 없습니다: $exe" }
if (-not (Test-Path $json)) { Die "latest.json 이 없습니다." }
Good ("{0}  ({1:N0} bytes)" -f (Split-Path $exe -Leaf), (Get-Item $exe).Length)

# ──────────────────────────────────────────────────────────── 4) 유출 검사
Step 4 '내부정보 유출 검사'
$bytes = [IO.File]::ReadAllBytes($exe)
$texts = @(
    [Text.Encoding]::UTF8.GetString($bytes),
    [Text.Encoding]::Unicode.GetString($bytes)
)
$rules = [ordered]@{
    '사내 IP'   = '(?:\b10\.|\b172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}'
    '사내 계정' = 'dk_admin|dkmepp|dseek|dkhrllm'
    '비밀번호'  = 'PDN_dk12|P@ssw0rd'
    '실명·경로' = '김장훈|janghoonkim|05_claude'
    '사업장'    = '당진|포항|DMES'
}
$found = 0
foreach ($t in $texts) {
    foreach ($k in $rules.Keys) {
        $m = [regex]::Matches($t, $rules[$k]) | Select-Object -First 3
        if ($m.Count -gt 0) {
            $found++
            Warn ("{0}: {1}" -f $k, (($m | ForEach-Object { $_.Value }) -join ', '))
        }
    }
}
if ($found -gt 0) { Die "exe 안에 내부정보가 남아 있습니다 ($found 건). 올리지 않았습니다." }
Good 'exe 안에 내부정보 없음'

if ($WhatIfOnly) { Write-Host "`n점검만 하고 끝냅니다 (-WhatIfOnly)." -ForegroundColor Yellow; exit 0 }

# ──────────────────────────────────────────────────────────── 5) 커밋·태그·푸시
if (-not $ReleaseOnly) {
    Step 5 '커밋 · 태그'
    (GitQ add -A) | Out-Null
    $msg = "$Version" + $(if ($Notes) { " - $Notes" } else { '' })
    $r = GitQ commit -q -m $msg
    if ($r.code -ne 0) { Warn '커밋할 변경이 없습니다 (계속 진행)' } else { Good "커밋: $msg" }

    $exists = (GitQ tag -l $Tag).out.Trim()
    if ($exists) { Warn "$Tag 태그가 이미 있습니다" }
    else { (GitQ tag -a $Tag -m "짱디터 $Version") | Out-Null; Good "태그 $Tag" }
}

Step 5 '푸시'
$r = GitQ push origin main
if ($r.code -ne 0) { Die ("main 푸시 실패`n" + $r.out) }
$r = GitQ push origin $Tag
if ($r.code -ne 0 -and $r.out -notmatch 'up to date|already exists') { Die ("태그 푸시 실패`n" + $r.out) }
Good '푸시 완료'

# ──────────────────────────────────────────────────────────── 6) 릴리스 생성 + 업로드
Step 6 "GitHub 릴리스 $Tag"
$rel = $null
try { $rel = Api GET "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag" } catch { }

if ($rel) {
    Warn "릴리스가 이미 있습니다 — 기존 파일을 지우고 다시 올립니다"
    foreach ($a in $rel.assets) {
        Api DELETE "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($a.id)" | Out-Null
    }
} else {
    $rel = Api POST "https://api.github.com/repos/$Owner/$Repo/releases" @{
        tag_name = $Tag
        name     = "짱디터 $Version"
        body     = $(if ($Notes) { $Notes } else { "짱디터 $Version" })
    }
    Good "릴리스 생성됨"
}

foreach ($f in @($exe, $json)) {
    $name = Split-Path $f -Leaf
    $uri = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$name"
    $h = @{
        Authorization          = "Bearer $script:Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'jjangditer-release'
    }
    Invoke-RestMethod -Uri $uri -Method Post -Headers $h -ContentType 'application/octet-stream' -InFile $f | Out-Null
    Good "올림: $name"
}

# ──────────────────────────────────────────────────────────── 7) 공개 주소로 확인
Step 7 '공개된 주소로 실제 확인'
Start-Sleep -Seconds 2
$base = "https://github.com/$Owner/$Repo/releases/latest/download"
$tmp = Join-Path $env:TEMP ("jjrel_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
try {
    $lj = Invoke-RestMethod -Uri "$base/latest.json" -UseBasicParsing
    if ($lj.version -ne $Version) { Die "latest.json 버전이 다릅니다: $($lj.version)" }
    Good "latest.json → $($lj.version)"

    Invoke-WebRequest -Uri "$base/$($lj.file)" -OutFile "$tmp\dl.exe" -UseBasicParsing
    $h1 = (Get-FileHash "$tmp\dl.exe" -Algorithm SHA256).Hash.ToLower()
    if ($h1 -ne $lj.sha256) { Die "내려받은 파일 해시가 다릅니다." }
    if ($h1 -ne (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()) { Die "원본과 다릅니다." }
    Good ("내려받기 확인 {0:N0} bytes · 해시 일치" -f (Get-Item "$tmp\dl.exe").Length)
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Green
Write-Host ("  짱디터 {0} 배포 완료" -f $Version) -ForegroundColor Green
Write-Host "═══════════════════════════════════════════" -ForegroundColor Green
Write-Host "  릴리스 : $($rel.html_url)"
Write-Host "  직원용 : https://github.com/$Owner/$Repo/releases/latest"
Write-Host "  업데이트는 6시간 안에 자동으로 안내됩니다."
Write-Host ""
