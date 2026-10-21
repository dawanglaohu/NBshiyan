# Actual tool: existing WSL FFmpeg package, /usr/bin/qt-faststart.
# Source file stays unchanged. The target must not already exist.
$ErrorActionPreference = 'Stop'
$taskOutput = 'D:/xiangmu/.codex-plans/NBshiyan-m1-t3/video2-web-1080p60-faststart.mp4'
if (Test-Path -LiteralPath $taskOutput) { throw 'Output exists; preserving it' }
wsl.exe --exec qt-faststart /mnt/c/Users/admin/Desktop/video2.mp4 /mnt/d/xiangmu/.codex-plans/NBshiyan-m1-t3/video2-web-1080p60-faststart.mp4
if ($LASTEXITCODE -ne 0) { throw 'MP4 index relocation failed' }
