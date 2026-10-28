$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if($PSVersionTable.PSEdition -ne 'Core'){$env:PSModulePath=(Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\Modules')+';'+(Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')+';'+(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules')}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$script:NoraProduct = 'NoraBridge.Universal.MVP'
$script:NoraUtf8 = New-Object Text.UTF8Encoding($false)

function Get-NoraDefaultDirectory {
    if(([IO.File]::GetAttributes($env:LOCALAPPDATA) -band [IO.FileAttributes]::Encrypted) -ne 0){return (Join-Path $env:USERPROFILE 'NoraBridge')}
    return (Join-Path $env:LOCALAPPDATA 'NoraBridge')
}
function Resolve-NoraDirectory([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.StartsWith('\\')) { throw '安装目录必须是本地磁盘绝对路径。' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.Length -le 3 -or $full -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')) { throw '不能将磁盘根目录或用户主目录作为安装目录。' }
    $cursor = $full
    while ($cursor.Length -gt 3) {
        if (Test-Path -LiteralPath $cursor) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'MVP 安装目录不支持目录联接或符号链接。' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}
function Write-NoraJson([string]$Path,$Value) {
    # Installer metadata is written only while the instance/tasks are stopped.
    # A flushed exclusive stream also works on EFS/filtered user directories where
    # ReplaceFile can be refused. Runtime IPC uses its separate atomic writer.
    if((Test-Path -LiteralPath $Path) -and (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw '拒绝写入重解析文件。'}
    $bytes=$script:NoraUtf8.GetBytes(($Value|ConvertTo-Json -Depth 12))
    $stream=New-Object IO.FileStream($Path,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-NoraTaskNames([string]$InstanceId) {
    if($InstanceId -notmatch '^[0-9a-f]{32}$'){throw '安装实例 ID 无效。'}
    $name = 'NoraBridge-MVP-'+$InstanceId
    return @{Main=$name;Watchdog=$name+'-Watchdog';Firewall=$name+'-Inbound'}
}
function Protect-NoraPath([string]$Path,[bool]$Directory) {
    if (-not ('NoraMvpAcl' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NoraMvpAcl {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool SetFileSecurity(string path,uint flags,byte[] descriptor);
}
'@
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($old in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($old) }
    if ($Directory) { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
    else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
    $acl.AddAccessRule($rule)
    if (-not [NoraMvpAcl]::SetFileSecurity($Path,[Convert]::ToUInt32('80000005',16),$acl.GetSecurityDescriptorBinaryForm())) {
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
}
function Get-NoraInstallation([string]$Directory) {
    $root = Resolve-NoraDirectory $Directory
    $manifestFile = Join-Path $root 'installation.json'
    if (-not (Test-Path -LiteralPath $manifestFile)) { throw '目录不是 Nora Bridge MVP 安装目录，未执行任何任务或文件操作。' }
    $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($manifest.product -ne $script:NoraProduct -or $manifest.root -ne $root -or $manifest.owner_sid -ne $sid) { throw '安装标识或 Windows 用户不匹配。' }
    return @{Root=$root;Manifest=$manifest;Tasks=(Get-NoraTaskNames $manifest.instance_id)}
}
function Stop-NoraInstallation([string]$Directory) {
    $installation = Get-NoraInstallation $Directory
    [IO.File]::WriteAllText((Join-Path $installation.Root 'disabled'),[DateTime]::UtcNow.ToString('o'),$script:NoraUtf8)
    foreach ($name in @($installation.Tasks.Watchdog,$installation.Tasks.Main)) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) { Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null; Stop-ScheduledTask -TaskName $name -ErrorAction Stop }
    }
    $exe = Join-Path $installation.Root 'nora-bridge.exe'
    Get-CimInstance Win32_Process -Filter "name='nora-bridge.exe'" | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Register-NoraTasks([string]$Directory,[bool]$Enabled) {
    $installation = Get-NoraInstallation $Directory
    $sid = $installation.Manifest.owner_sid
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    foreach ($watchdog in @($false,$true)) {
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = 'Nora Bridge Universal MVP - 当前用户交互桌面'
        $definition.Principal.UserId=$sid; $definition.Principal.LogonType=3; $definition.Principal.RunLevel=0
        $settings=$definition.Settings
        $settings.Enabled=$Enabled; $settings.Hidden=$true; $settings.StartWhenAvailable=$true; $settings.MultipleInstances=2
        $settings.DisallowStartIfOnBatteries=$false; $settings.StopIfGoingOnBatteries=$false
        $settings.ExecutionTimeLimit='PT0S'; $settings.UseUnifiedSchedulingEngine=$false
        $settings.RestartCount=3; $settings.RestartInterval='PT1M'
        $trigger=$definition.Triggers.Create(9);$trigger.UserId=$sid;$trigger.Enabled=$true
        $name=$installation.Tasks.Main
        if($watchdog) {
            $name=$installation.Tasks.Watchdog; $settings.ExecutionTimeLimit='PT45S'
            $repeat=$definition.Triggers.Create(1);$repeat.StartBoundary=[DateTime]::Now.AddSeconds(10).ToString('yyyy-MM-ddTHH:mm:ss');$repeat.Repetition.Interval='PT1M';$repeat.Enabled=$true
        }
        $action=$definition.Actions.Create(0)
        $action.Path=Join-Path $installation.Root 'nora-bridge.exe'
        $action.WorkingDirectory=$installation.Root
        $action.Arguments='--data-dir "'+$installation.Root+'"'
        if($watchdog){$action.Arguments+=' --watchdog'}
        $descriptor='O:'+$sid+'D:P(A;;GA;;;'+$sid+')(A;;GA;;;SY)(A;;GA;;;BA)'
        $null=$folder.RegisterTaskDefinition($name,$definition,6,$sid,$null,3,$descriptor)
    }
}
function Wait-NoraReady([string]$Directory,[int]$Seconds=15) {
    $installation=Get-NoraInstallation $Directory
    $configuration=[IO.File]::ReadAllText((Join-Path $installation.Root 'config.json'))|ConvertFrom-Json
    $expected=$configuration.listen_ip+':'+$configuration.listen_port
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while($clock.Elapsed.TotalSeconds -lt $Seconds){
        $runtimeFile=Join-Path $installation.Root 'runtime.json'
        if(Test-Path -LiteralPath $runtimeFile){
            try{
                $runtime=[IO.File]::ReadAllText($runtimeFile)|ConvertFrom-Json
                $process=Get-Process -Id $runtime.pid -ErrorAction Stop
                if($runtime.listen -eq $expected -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $runtime.session.process_start_ticks){
                    $listener=@(Get-NetTCPConnection -LocalPort $configuration.listen_port -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalAddress -eq $configuration.listen_ip -and $_.OwningProcess -eq $runtime.pid})
                    if($listener.Count -eq 1){return $runtime}
                }
            }catch{}
        }
        Start-Sleep -Milliseconds 250
    }
    throw ('程序尚未成功监听；安装文件保留，请查看 '+(Join-Path $installation.Root 'logs')+' 或运行 Status.ps1。')
}
function Test-NoraTailnetIPv4([string]$Value) {
    $address=$null
    if(-not [Net.IPAddress]::TryParse($Value,[ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork){return $false}
    $bytes=$address.GetAddressBytes()
    return $bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127 -and $address.ToString() -eq $Value
}
