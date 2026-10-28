param([string]$InstallDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if(-not $InstallDir){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')){$InstallDir=$PSScriptRoot}else{$InstallDir=Get-NoraDefaultDirectory}}
$installation=Get-NoraInstallation $InstallDir
$config=Get-Content -LiteralPath (Join-Path $installation.Root 'config.json') -Raw|ConvertFrom-Json
$runtime=$null;if(Test-Path -LiteralPath (Join-Path $installation.Root 'runtime.json')){$runtime=Get-Content -LiteralPath (Join-Path $installation.Root 'runtime.json') -Raw|ConvertFrom-Json}
[pscustomobject]@{directory=$installation.Root;configured_address=($config.listen_ip+':'+$config.listen_port);runtime=$runtime;tasks=@(Get-ScheduledTask -TaskName $installation.Tasks.Main,$installation.Tasks.Watchdog|Select-Object TaskName,State);listeners=@(Get-NetTCPConnection -LocalPort $config.listen_port -State Listen -ErrorAction SilentlyContinue|Select-Object LocalAddress,LocalPort,OwningProcess);token_file=(Join-Path $installation.Root 'token.txt')}|ConvertTo-Json -Depth 6
