param([string]$InstallDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if(-not $InstallDir){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')){$InstallDir=$PSScriptRoot}else{$InstallDir=Get-NoraDefaultDirectory}}
$installation=Get-NoraInstallation $InstallDir
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '仅添加防火墙规则需要管理员 PowerShell；请按 README 手动运行，脚本不会发起 UAC。'}
$config=Get-Content -LiteralPath (Join-Path $installation.Root 'config.json') -Raw|ConvertFrom-Json
if(-not (Test-NoraTailnetIPv4 $config.listen_ip) -or -not (Test-NoraTailnetIPv4 $config.allowed_peer.ip)){throw '配置不是 Tailscale IPv4。'}
Get-NetFirewallRule -Name $installation.Tasks.Firewall -ErrorAction SilentlyContinue|Remove-NetFirewallRule
New-NetFirewallRule -Name $installation.Tasks.Firewall -DisplayName $installation.Tasks.Firewall -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $config.listen_ip -LocalPort $config.listen_port -RemoteAddress $config.allowed_peer.ip -Program (Join-Path $installation.Root 'nora-bridge.exe') -InterfaceAlias $config.tailscale_interface -Profile Any|Out-Null
Write-Output '已添加仅该程序、Tailscale 地址/网卡、指定端口、指定 Agent IP 的入站规则。'
