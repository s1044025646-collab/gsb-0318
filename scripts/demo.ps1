# Intel HEX 后端演示脚本（Windows PowerShell，无需 Docker/WSL）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:IHEX_DATA_DIR = Join-Path $root 'data'

Write-Host '== 构建 ==' -ForegroundColor Cyan
npm run build

Write-Host "`n== 1) CLI 导入演示夹具（04 -> 两段数据 -> 02）==" -ForegroundColor Cyan
node --disable-warning=ExperimentalWarning dist/cli/index.js import fixtures/demo.hex

Write-Host "`n== 2) 查看稀疏地址段与启动元数据 ==" -ForegroundColor Cyan
node --disable-warning=ExperimentalWarning dist/cli/index.js segments 1

Write-Host "`n== 3) 定位绝对地址来源（同样低偏移 0000，不同基址）==" -ForegroundColor Cyan
node --disable-warning=ExperimentalWarning dist/cli/index.js source 1 --address 0x00010000
node --disable-warning=ExperimentalWarning dist/cli/index.js source 1 --address 0x000F0000

Write-Host "`n== 4) 导出含空洞区间：先拒绝，再用 0xFF 填充 ==" -ForegroundColor Cyan
node --disable-warning=ExperimentalWarning dist/cli/index.js export 1 --start 0x10000 --end 0x10101 --gap fill --fill 0xFF

Write-Host "`n== 5) 坏夹具（校验损坏）应失败且不产生新导入 ==" -ForegroundColor Cyan
node --disable-warning=ExperimentalWarning dist/cli/index.js import fixtures/bad_checksum.hex
if ($LASTEXITCODE -ne 0) { Write-Host '已按预期拒绝（退出码非零）' -ForegroundColor Yellow }
node --disable-warning=ExperimentalWarning dist/cli/index.js list

Write-Host "`n== 6) 启动 HTTP 服务（空闲端口）并演示重启后查询 ==" -ForegroundColor Cyan
$env:IHEX_PORT = '0'
$proc = Start-Process -FilePath node -ArgumentList '--disable-warning=ExperimentalWarning','dist/server/index.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput data/server.out
Start-Sleep -Seconds 2
$line = Get-Content data/server.out | Select-String 'http://127.0.0.1:(\d+)'
$port = $line.Matches[0].Groups[1].Value
Write-Host "服务端口: $port"
(Invoke-RestMethod "http://127.0.0.1:$port/health") | ConvertTo-Json -Compress
(Invoke-RestMethod "http://127.0.0.1:$port/imports") | ConvertTo-Json -Depth 5
(Invoke-RestMethod "http://127.0.0.1:$port/imports/1/segments") | ConvertTo-Json -Depth 5
Stop-Process -Id $proc.Id -Force
Write-Host "`n== 演示完成；数据位于 data/ 目录 ==" -ForegroundColor Green
