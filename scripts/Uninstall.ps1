param([string]$InstallDir,[switch]$DeleteData)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if(-not $InstallDir){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')){$InstallDir=$PSScriptRoot}else{$InstallDir=Get-NoraDefaultDirectory}}
$installation=Get-NoraInstallation $InstallDir
Stop-NoraInstallation $installation.Root
foreach($name in @($installation.Tasks.Watchdog,$installation.Tasks.Main)){if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop}}
$rule=Get-NetFirewallRule -Name $installation.Tasks.Firewall -ErrorAction SilentlyContinue
if($rule){try{$rule|Remove-NetFirewallRule -ErrorAction Stop}catch{Write-Warning '可选防火墙规则需管理员删除；程序已停止。'}}
if($DeleteData){
    # Verify the absolute managed root before recursive removal. Remove reparse
    # entries themselves without following their targets, including on PS 5.1.
    $safeRoot=Resolve-NoraDirectory $installation.Root
    if($safeRoot -ne $installation.Manifest.root){throw '删除目标与安装标识不符。'}
    function Remove-NoraEntry([string]$Path){
        $full=[IO.Path]::GetFullPath($Path)
        if($full -ne $safeRoot -and -not $full.StartsWith($safeRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw '拒绝越界删除。'}
        $attributes=[IO.File]::GetAttributes($full)
        if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){
            if(($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){foreach($entry in [IO.Directory]::GetFileSystemEntries($full)){Remove-NoraEntry $entry}}
            [IO.Directory]::Delete($full,$false)
        }else{[IO.File]::Delete($full)}
    }
    Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($safeRoot))
    Remove-NoraEntry $safeRoot
    Write-Output '程序、任务及该安装目录的数据已删除。'
}else{Write-Output ('已卸载并保留 token、日志与任务结果：'+$installation.Root)}
