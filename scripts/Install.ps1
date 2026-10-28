param(
    [string]$InstallDir,
    [string]$Peer,
    [int]$Port=0,
    [string]$EgoPath,
    [string]$TailscalePath,
    [switch]$SkipEgo,
    [switch]$NoStart,
    [switch]$NonInteractive
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    if(-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess){throw '需要 Windows x64 与 64 位 PowerShell。'}
    $release=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction Stop).Release
    if($release -lt 528040){throw '需要系统 .NET Framework 4.8 或更高版本。'}
    if(-not $InstallDir){$InstallDir=Get-NoraDefaultDirectory}
    $root=Resolve-NoraDirectory $InstallDir
    $storage=$root
    while(-not (Test-Path -LiteralPath $storage)){$storage=[IO.Path]::GetDirectoryName($storage)}
    if(([IO.File]::GetAttributes($storage) -band [IO.FileAttributes]::Encrypted) -ne 0){throw 'MVP 不支持 EFS 加密安装目录。请选择未加密目录，例如用户主目录下的 NoraBridge；不会修改已有文件的加密状态。'}
    if(-not $TailscalePath){$command=Get-Command tailscale.exe -ErrorAction SilentlyContinue;if($command){$TailscalePath=$command.Source}else{$TailscalePath=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'}}
    if(-not (Test-Path -LiteralPath $TailscalePath -PathType Leaf)){throw '未找到 Tailscale，请先安装并登录 Tailscale。'}
    $TailscalePath=[IO.Path]::GetFullPath($TailscalePath)
    $raw=& $TailscalePath status --json
    if($LASTEXITCODE -ne 0){throw '读取 Tailscale 状态失败。'}
    $status=($raw -join "`n")|ConvertFrom-Json
    if($status.BackendState -ne 'Running' -or -not $status.Self.ID){throw '请先登录并连接 Tailscale。'}
    $localIp=@($status.Self.TailscaleIPs|Where-Object {Test-NoraTailnetIPv4 $_})
    if($localIp.Count -ne 1){throw '需要一个有效的本机 Tailscale IPv4 地址。'}
    $network=@(Get-NetIPAddress -IPAddress $localIp[0] -AddressFamily IPv4 -ErrorAction Stop)
    if($network.Count -ne 1){throw '无法唯一确定 Tailscale 网卡，安装已停止。'}
    $adapter=Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object ifIndex -eq $network[0].InterfaceIndex
    if(($adapter.Name+' '+$adapter.InterfaceDescription) -notmatch 'Tailscale'){throw '地址未绑定到可识别的 Tailscale 网卡。'}
    $peers=@($status.Peer.PSObject.Properties.Value|Where-Object {$_.ID -and @($_.TailscaleIPs|Where-Object {Test-NoraTailnetIPv4 $_}).Count -eq 1}|Sort-Object HostName)
    if(-not $peers.Count){throw 'tailnet 中没有可选择的 Agent 设备。'}
    if(-not $Peer) {
        if($NonInteractive){throw '无人值守安装必须通过 -Peer 指定唯一授权设备，不能自动放行所有设备。'}
        Write-Host '请选择唯一允许控制本机的 Agent 设备：'
        for($index=0;$index -lt $peers.Count;$index++){Write-Host ('[{0}] {1}  {2}' -f ($index+1),$peers[$index].HostName,(@($peers[$index].TailscaleIPs|Where-Object {Test-NoraTailnetIPv4 $_})[0]))}
        $selected=0
        if(-not [int]::TryParse((Read-Host '输入设备编号'),[ref]$selected) -or $selected -lt 1 -or $selected -gt $peers.Count){throw '没有选择有效设备。'}
        $Peer=$peers[$selected-1].ID
    }
    $peerMatches=@($peers|Where-Object {$_.ID -eq $Peer -or $_.HostName -eq $Peer -or $_.TailscaleIPs -contains $Peer})
    if($peerMatches.Count -ne 1){throw 'Agent 设备不存在或名称有歧义，请使用 Tailscale 设备 ID/IP。'}
    $agent=$peerMatches[0];$agentIp=@($agent.TailscaleIPs|Where-Object {Test-NoraTailnetIPv4 $_})[0]
    $existing=$null
    if(Test-Path -LiteralPath $root){
        if(Test-Path -LiteralPath (Join-Path $root 'installation.json')){$existing=Get-NoraInstallation $root}
        elseif(@(Get-ChildItem -LiteralPath $root -Force).Count){throw '目标目录非空且不是本产品安装目录，拒绝覆盖。'}
    }
    if($SkipEgo){$EgoPath=$null}
    elseif(-not $EgoPath){$candidate=Join-Path $env:USERPROFILE '.local\share\ego\active_version_dir\ego-browser.exe';if(Test-Path -LiteralPath $candidate -PathType Leaf){$EgoPath=$candidate}}
    if($EgoPath){$EgoPath=[IO.Path]::GetFullPath($EgoPath);if(-not (Test-Path -LiteralPath $EgoPath -PathType Leaf)){throw 'Ego 路径不是可执行文件。'}}
    $occupied=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    if($Port -eq 0){
        for($candidate=17643;$candidate -le 17663;$candidate++){if(-not ($occupied|Where-Object LocalPort -eq $candidate)){$Port=$candidate;break}}
    }
    if($Port -lt 1024 -or $Port -gt 65535){throw '端口必须在 1024 至 65535 之间。'}
    $conflict=@($occupied|Where-Object LocalPort -eq $Port)
    if($conflict.Count){
        $ownIds=@(Get-CimInstance Win32_Process -Filter "name='nora-bridge.exe'"|Where-Object ExecutablePath -eq (Join-Path $root 'nora-bridge.exe')|Select-Object -ExpandProperty ProcessId)
        if(@($conflict|Where-Object {$ownIds -notcontains $_.OwningProcess}).Count){throw '所选端口已被其它程序使用；请改端口。'}
    }
    $payload=Join-Path $PSScriptRoot 'nora-bridge.exe'
    if(-not (Test-Path -LiteralPath $payload -PathType Leaf)){throw '安装包缺少 nora-bridge.exe，请使用完整分发包。'}
    # All discovery and conflict checks finish before stopping/updating anything.
    if($existing){Stop-NoraInstallation $root}else{[IO.Directory]::CreateDirectory($root)|Out-Null}
    Protect-NoraPath $root $true
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $instanceId=[guid]::NewGuid().ToString('N');if($existing){$instanceId=$existing.Manifest.instance_id}
    $names=Get-NoraTaskNames $instanceId
    $manifest=@{product=$script:NoraProduct;schema_version=1;instance_id=$instanceId;root=$root;owner_sid=$sid;installed_at=[DateTime]::UtcNow.ToString('o')}
    Write-NoraJson (Join-Path $root 'installation.json') $manifest
    foreach($dir in @('jobs','logs','runtime','control','evidence')){[IO.Directory]::CreateDirectory((Join-Path $root $dir))|Out-Null}
    $token=Join-Path $root 'token.txt'
    if((Test-Path -LiteralPath $token) -and (([IO.File]::GetAttributes($token) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'token 文件不能是符号链接。'}
    if(-not (Test-Path -LiteralPath $token)){
        $bytes=New-Object byte[] 48;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
        [IO.File]::WriteAllText($token,[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant(),$script:NoraUtf8)
    }
    if([IO.File]::ReadAllText($token) -notmatch '^[0-9a-f]{96}$'){throw '现有 token 格式不正确；未自动覆盖。'}
    Protect-NoraPath $token $false
    $files=@('nora-bridge.exe','Install.ps1','Common.ps1','Start.ps1','Stop.ps1','Status.ps1','Uninstall.ps1','Enable-Firewall.ps1','README.md','MVP-验收报告.md','client.py','LICENSE-Node.txt')
    foreach($file in $files){$source=Join-Path $PSScriptRoot $file;$destination=Join-Path $root $file;if((Test-Path -LiteralPath $destination) -and (([IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw '安装目标文件不能是重解析点。'};if((Test-Path -LiteralPath $source) -and [IO.Path]::GetFullPath($source) -ne $destination){Copy-Item -LiteralPath $source -Destination $destination -Force}}
    $egoConfig=$null;if($EgoPath){$egoConfig=$EgoPath}
    $config=@{schema_version=1;instance_id=$instanceId;install_dir=$root;owner_profile=$env:USERPROFILE;owner_sid=$sid;listen_ip=$localIp[0];listen_port=$Port;self_node_id=$status.Self.ID;tailscale_path=$TailscalePath;tailscale_interface=$network[0].InterfaceAlias;allowed_peer=@{id=$agent.ID;name=$agent.HostName;ip=$agentIp};ego_path=$egoConfig;file_root=$env:USERPROFILE;task_name=$names.Main;watchdog_task_name=$names.Watchdog}
    Write-NoraJson (Join-Path $root 'config.json') $config
    [IO.File]::WriteAllText((Join-Path $root 'disabled'),'installing',$script:NoraUtf8)
    Register-NoraTasks $root (-not $NoStart)
    $firewall='unverified'
    $existingRules=@(Get-NetFirewallRule -DisplayName 'Tailscale-In' -ErrorAction SilentlyContinue|Where-Object {$_.Enabled -eq 'True' -and $_.Action -eq 'Allow'}|Get-NetFirewallAddressFilter|Where-Object {$_.LocalAddress -contains $localIp[0]})
    if($existingRules.Count){$firewall='existing Tailscale-In rule'}
    if(-not $NoStart){Remove-Item -LiteralPath (Join-Path $root 'disabled') -Force;Start-ScheduledTask -TaskName $names.Main -ErrorAction Stop;$null=Wait-NoraReady $root}
    $report=@{product=$script:NoraProduct;version='0.1.1';directory=$root;listen=($localIp[0]+':'+$Port);agent=$agent.HostName;agent_ip=$agentIp;token_file=$token;ego_enabled=[bool]$EgoPath;main_task=$names.Main;watchdog_task=$names.Watchdog;started=(-not $NoStart);firewall=$firewall}
    Write-NoraJson (Join-Path $root 'installation-result.json') $report
    Write-Host 'Nora Bridge MVP 安装完成。'
    Write-Host ('监听地址：http://'+$report.listen)
    Write-Host ('唯一授权设备：'+$agent.HostName+' / '+$agentIp)
    Write-Host ('Token 文件：'+$token)
    Write-Host ('安装目录：'+$root)
    if(-not $EgoPath){Write-Host 'Ego 未配置；exec/file 可用，ego 接口返回 503。'}
    if($firewall -eq 'unverified'){Write-Warning '没有确认现有防火墙放行。若 Agent 无法连接，可按 README 用管理员运行 Enable-Firewall.ps1 添加精确规则。'}
    exit 0
} catch {Write-Error ('安装未完成：'+$_.Exception.Message) -ErrorAction Continue;exit 1}
