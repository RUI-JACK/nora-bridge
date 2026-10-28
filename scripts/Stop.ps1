param([string]$InstallDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if(-not $InstallDir){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')){$InstallDir=$PSScriptRoot}else{$InstallDir=Get-NoraDefaultDirectory}}
Stop-NoraInstallation $InstallDir
Write-Output 'Nora Bridge 已停止，两个自启/恢复任务已停用。'
