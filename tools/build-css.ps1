# 构建 Tailwind CSS：把 css/twin.src.css 编译成 css/twin.css
#
# 首次使用需要装依赖（只装一次，node_modules 不入库）：
#   cd .build/tw
#   npm init -y
#   npm install tailwindcss@3.4.17
#
# 之后每次改完 index.html / js/twin.js 里的 class 或本目录的源样式，执行：
#   pwsh -File tools/build-css.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cli = Join-Path $root '.build\tw\node_modules\tailwindcss\lib\cli.js'
if (-not (Test-Path $cli)) {
    Write-Host '未找到 tailwindcss，请先执行：' -ForegroundColor Yellow
    Write-Host '  cd .build/tw; npm init -y; npm install tailwindcss@3.4.17' -ForegroundColor Yellow
    exit 1
}

& node $cli -c tailwind.config.js -i css/twin.src.css -o css/twin.css --minify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$size = (Get-Item (Join-Path $root 'css\twin.css')).Length
Write-Host ("css/twin.css 已生成（{0:N1} KB）" -f ($size / 1024))
