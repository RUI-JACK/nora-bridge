param([string]$InstallDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if(-not $InstallDir){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')){$InstallDir=$PSScriptRoot}else{$InstallDir=Get-NoraDefaultDirectory}}
$installation=Get-NoraInstallation $InstallDir
foreach($name in @($installation.Tasks.Main,$installation.Tasks.Watchdog)){Enable-ScheduledTask -TaskName $name -ErrorAction Stop|Out-Null}
Remove-Item -LiteralPath (Join-Path $installation.Root 'disabled') -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $installation.Tasks.Main -ErrorAction Stop
$null=Wait-NoraReady $installation.Root
Write-Output 'Nora Bridge 已启动，并启用登录自启与恢复任务。'
