# Nora Bridge — Windows x64 通用安装 MVP

版本 **0.1.1**。这是从专用版 1.0.3 的进程管理核心独立出来的通用安装版本。没有编译进用户名、本机 IP、Agent 名称或旧 token，不会接管已有专用版。

0.1.1 补全了供新电脑本地 Agent 执行的部署与验收流程；运行核心沿用 0.1.0。本机历史功能验收记录见 MVP-验收报告.md，不能把该记录当作其它新电脑已经通过的证据。

它是一个远程执行桥，**不包含 AI Agent、模型服务或 Tailscale/Ego 安装包**。全新电脑只装 Nora Bridge 还不能被远端控制，需要按下面的步骤准备网络与 Agent。

`你的 Agent → Tailscale 私有网络 → Windows 上的 Nora Bridge → PowerShell / 文件 / Ego（可选）`

## 下载

- [Windows x64 安装器](https://github.com/RUI-JACK/nora-bridge/releases/download/v0.1.1/NoraBridge-0.1.1-Setup-x64.exe)：普通使用者下载这个文件。
- [ZIP 安装版](https://github.com/RUI-JACK/nora-bridge/releases/download/v0.1.1/NoraBridge-0.1.1-windows-x64.zip)：解压到临时文件夹后运行 Setup.cmd。
- [源码 ZIP](https://github.com/RUI-JACK/nora-bridge/releases/download/v0.1.1/NoraBridge-0.1.1-source.zip) · [SHA-256 校验文件](https://github.com/RUI-JACK/nora-bridge/releases/download/v0.1.1/SHA256SUMS.txt) · [版本说明](https://github.com/RUI-JACK/nora-bridge/releases/tag/v0.1.1)。

GitHub 的 **Code → Download ZIP** 是源码，需要自行构建；直接安装请使用上面的 Release 安装器。私有仓库的下载需要先登录已获授权的 GitHub 账号。

## 给新电脑上的 Agent：按此流程帮助机主配置

本节供**已经能在这台 Windows 电脑执行本地命令**的 Agent 使用。安装桥的本地 Agent 与以后通过网络控制电脑的远端 Agent 可以不同。白名单里应选择**远端控制设备**，不能选择本机，也不能因为当前 Agent 负责安装就默认授权它的其它设备。

只有远端聊天能力、尚无本机执行通道的 Agent，无法借助一个尚未安装的桥完成首次部署。需要机主先在新电脑上启动有本地工具权限的 Agent，或亲自运行安装向导。仓库目前为私有时，还需由机主授权 GitHub 访问，或把 Release 的 ZIP 与 SHA256SUMS.txt 下载到新电脑交给 Agent；不要索要或记录机主的 GitHub 密码。

### 机主可以直接交给 Agent 的任务说明

```text
请按这份 README 的 Agent 部署流程，在当前 Windows 电脑配置 Nora Bridge。
先自动检查系统、当前用户与会话、Tailscale、.NET Framework 和已有安装。
缺失依赖按 README 的官方安装方法处理；网页登录、MFA、系统 UAC 和 Ego 首次引导由我完成。
远端授权设备：<填写 Tailscale 设备名、IP 或设备 ID>。
是否需要 Ego 浏览器自动化：<需要 / 暂不需要>。
使用未加密的当前用户独立目录，不修改已有专用版、ego-run 或其它软件的任务。
如果授权设备没有指定、找不到或有重名，请先列出候选设备，让我明确选择；不要自行猜测。
完成后检查实际监听、任务、鉴权和命令执行；远端尚未实测的项目明确标为待验。
只报告 token 的文件路径，不把 token 值放入聊天、命令行、日志或 GitHub。
```

### A. 自动检测，避免让机主重复填写机器信息

先只读检查；不要运行安装器来猜测现有部署是否可以覆盖。以下代码使用 PowerShell，输出中不包含 token：

```powershell
$ps51 = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tsCommand = Get-Command tailscale.exe -ErrorAction SilentlyContinue
$tailscale = if ($tsCommand) { $tsCommand.Source } else { Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
$framework = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
[pscustomobject]@{
    os_x64 = [Environment]::Is64BitOperatingSystem
    process_x64 = [Environment]::Is64BitProcess
    user_profile = $env:USERPROFILE
    session_id = [Diagnostics.Process]::GetCurrentProcess().SessionId
    powershell_51_present = Test-Path -LiteralPath $ps51
    net_framework_release = $framework.Release
    tailscale_present = Test-Path -LiteralPath $tailscale
    candidate_install = Join-Path $env:USERPROFILE 'NoraBridge'
} | ConvertTo-Json
```

缺失依赖按下面“新电脑需要哪些软件”章节处理。Tailscale 已安装并登录后，自动列出远端候选设备，让机主确认要授权的那一台；已有明确且唯一的机主指定设备时，无需重复询问：

```powershell
$rawStatus = & $tailscale status --json
if ($LASTEXITCODE -ne 0) { throw 'Tailscale 状态读取失败' }
$tailnet = ($rawStatus -join "`n") | ConvertFrom-Json
if ($tailnet.BackendState -ne 'Running') { throw '请先由机主完成 Tailscale 登录' }
$tailnet.Peer.PSObject.Properties.Value | ForEach-Object {
    [pscustomobject]@{ name = $_.HostName; id = $_.ID; ips = ($_.TailscaleIPs -join ', '); online = $_.Online }
} | Format-Table -AutoSize
```

安装目录、IP、SID 和网卡都应使用本机检测结果。不要复制其它电脑的 config.json、installation.json 或 token，也不要把说明里的示例 IP 当作实际配置。

### B. 使用已构建的分发包，校验后解压

无需在新电脑上编译，也无需为部署安装 Node/npm/Git。优先使用 Release 的二进制 ZIP，这样本地 Agent 可直接调用内含的 Install.ps1。如果已有已授权的 GitHub CLI，可以用 `gh release download` 下载；否则由机主通过 GitHub 登录下载这两个文件即可。

把下面的下载目录改成两个文件实际所在的目录；必须使用同一个 Release 的 ZIP 和校验文件：

```powershell
$downloadDir = Join-Path $env:USERPROFILE 'Downloads'
$packageName = 'NoraBridge-0.1.1-windows-x64.zip'
$packageFile = Join-Path $downloadDir $packageName
$checksumFile = Join-Path $downloadDir 'SHA256SUMS.txt'
$pattern = '(?im)^([0-9a-f]{64})  ' + [regex]::Escape($packageName) + '\r?$'
$checksum = [regex]::Match([IO.File]::ReadAllText($checksumFile), $pattern)
if (-not $checksum.Success) { throw '校验文件不包含所选安装包' }
$actualHash = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash
if ($actualHash -ne $checksum.Groups[1].Value) { throw '安装包校验失败，停止安装' }
$payload = Join-Path $env:TEMP ('NoraBridge-Payload-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $packageFile -DestinationPath $payload
if (-not (Test-Path -LiteralPath (Join-Path $payload 'Install.ps1'))) { throw '请使用二进制安装 ZIP，不能使用源码 ZIP' }
```

### C. 用已确认的设备 ID 安装，再启动

以下变量中的设备 ID 必须替换为上一步机主已确认的远端节点 ID。先安装但不启动，再检查安装结果；此例暂不启用 Ego。安装目录若已有本产品实例，重新安装会更新并停止该实例；先核对它是否就是本次要配置的实例。非空且非本产品的目录会被拒绝。

```powershell
$peerId = '<机主已确认的远端Tailscale设备ID>'
if ($peerId -match '[<>]' -or [string]::IsNullOrWhiteSpace($peerId)) { throw '必须先指定已确认的远端设备 ID' }
$installDir = Join-Path $env:USERPROFILE 'NoraBridge'
$installer = Join-Path $payload 'Install.ps1'
& $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -NonInteractive -InstallDir $installDir -Peer $peerId -SkipEgo -NoStart
if ($LASTEXITCODE -ne 0) { throw '安装未完成；查看错误后修复，不要放宽白名单' }
$installed = [IO.File]::ReadAllText((Join-Path $installDir 'installation-result.json')) | ConvertFrom-Json
$installed | Select-Object version, directory, listen, agent, agent_ip, token_file, ego_enabled, started
& $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installDir 'Start.ps1')
if ($LASTEXITCODE -ne 0) { throw '启动失败；检查日志及 Tailscale 身份，不要改成监听全部网卡' }
```

需要 Ego 且机主已完成首次引导时，将安装命令中的 `-SkipEgo` 替换成 `-EgoPath $egoExe`，其中 $egoExe 是已检查存在的真实 ego-browser.exe 绝对路径。不要同时传这两个参数。端口默认自动选取，不能因为默认端口已占用就终止其它程序。目录采用上面的显式路径以便后续命令一致；若该目录加密或机主另有指定，应先改为合适的未加密独立目录。

### D. 分别完成本机检查和远端验收

本机先运行 Status.ps1，确认实际监听位于 Tailscale 网卡、PID 存活、主任务在运行、watchdog 已启用。token 只确认文件存在和访问权限，不读取到输出中。需要执行本机内置功能自测时，可以运行：

```powershell
& $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installDir 'Status.ps1')
if ($LASTEXITCODE -ne 0) { throw '状态检查失败' }
$selfTestArgs = '--data-dir "' + $installDir + '" --self-test'
$selfTest = Start-Process -FilePath (Join-Path $installDir 'nora-bridge.exe') -ArgumentList $selfTestArgs -WindowStyle Hidden -PassThru -Wait
if ($selfTest.ExitCode -ne 0) { throw '本机功能自测进程失败' }
$evidence = [IO.File]::ReadAllText((Join-Path $installDir 'evidence\self-test.json')) | ConvertFrom-Json
if (-not $evidence.passed -or $evidence.pid -ne $selfTest.Id) { throw '没有本次自测通过的证据' }
$evidence | Select-Object version, passed, elapsed_seconds
```

内置自测会真实执行命令、35 秒后台任务、超时清理与文件往返；启用 Ego 时还会测试其执行和超时清理。它模拟授权来源，**不能代替远端网络验收**。请在机主当前交互桌面会话运行，不能从服务或 SSH 会话直接启动这项自测。

随后让被授权的远端 Agent 按下文“首次连接的完整例子”执行 health、echo、60 秒任务，以及需要时的 Ego 和文件往返。机主通过可信方式将 token 放入远端既有密钥存储，本地 Agent 不在聊天中代为展示密钥。若当前只有本地 Agent，先报告本机通过、远端待验，不通过放行 localhost 或其它来源来冒充验收。防火墙缺少精确规则时按本 README 处理管理员步骤；不要关闭全局防火墙。

最终向机主提交：版本、安装目录、监听地址、授权设备、token 文件路径、Ego 是否启用、启动/停止/卸载命令、每项实测输出和待验项目。注销重登由机主在合适时机执行，不能为做验收擅自注销正在使用的桌面。

## 新电脑需要哪些软件

| 软件或条件 | 安装在哪里 | 是否必需 | 安装与用途 |
| --- | --- | --- | --- |
| Windows 10/11 Intel/AMD x64 | 被控制电脑 | 是 | 本分支目标平台；Windows ARM64、32 位系统不在支持范围 |
| .NET Framework 4.8 或更高版本 | 被控制电脑 | 是 | 安装器和原生宿主依赖；已有时无需重装，缺少时按下文安装微软 Runtime |
| Windows PowerShell 5.1 | 被控制电脑 | 是 | 使用 Windows 自带的 powershell.exe；PowerShell 7 不能替代此依赖 |
| Tailscale | 被控制电脑与 Agent 所在设备 | 是 | 两端登录同一 tailnet，且允许 Agent 连接桥的 TCP 端口 |
| Nora Bridge | 被控制电脑 | 是 | 运行本项目的安装器，选择唯一授权的 Agent |
| 能发 HTTP 请求或执行脚本的 AI Agent | 另一台设备/云主机 | 是 | 由你自行准备；本项目不会创建 Agent、配置模型账号或支付模型调用费用 |
| Ego Lite | 被控制电脑 | 浏览器自动化时需要 | 不装也能用 exec/file；未配置时 /ego 返回 503 |
| Python 3 | Agent 所在设备 | 使用 client.py 时需要 | 仅用标准库，无需 pip install；已有 HTTP 工具的 Agent 也可直接调用 API |
| Node.js 24 x64 | 构建源码的 Windows 电脑 | 仅开发构建需要 | 发布的运行时已内嵌 Node；普通使用者无需安装 Node/npm、Git 或 Visual Studio |

Nora Bridge 按当前用户安装；Tailscale、缺失的系统 Runtime 和可选防火墙规则的安装可能需要管理员权限。桥本身不要“以其他用户身份”安装，应使用将来实际登录桌面的那个 Windows 账号。

### 1. 安装并配置 Tailscale（两端都要做）

Windows 电脑按 [Tailscale 官方 Windows 安装说明](https://tailscale.com/docs/install/windows)下载并运行安装器，然后在托盘图标中选择登录。下载入口是 [tailscale.com/download](https://tailscale.com/download)。

Agent 在另一台 Windows/macOS 设备时，安装对应客户端并登录同一 tailnet。Agent 在 Linux 云主机时，按 [官方 Linux 安装说明](https://tailscale.com/docs/install/linux)选择发行版安装；官方自动安装方式为：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
tailscale ip -4
```

浏览器完成登录后，两端的 tailscale status 应能看到彼此。本项目安装器会列出 Agent 设备，必须主动选择一台，不会自动放行整个 tailnet。

Windows 上若 tailscale 命令尚未进入 PATH，可直接运行：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" status
& "$env:ProgramFiles\Tailscale\tailscale.exe" ip -4
```

Agent 所在的**实际执行环境**必须能访问 tailnet。只有聊天网页、没有 tailnet 网络或外部工具执行能力的云端聊天服务，不能仅凭一个 URL 使用此桥。容器、代理或子网路由改变真实 TCP 来源时，也可能被白名单拒绝。

### 2. 检查 Windows Runtime 与登录条件

在本机 PowerShell 检查 .NET Framework：

```powershell
(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full').Release
```

数值至少为 **528040** 才符合 4.8 最低要求。缺少或低于该数值时，到[微软 .NET Framework 4.8 下载页](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net48)安装 **Runtime**，按提示重启后再运行桥的安装器；无需 Developer Pack。.NET 8/9 等现代 .NET 与此处的 .NET Framework 是不同产品，不能替代这个检查。[微软版本检查说明](https://learn.microsoft.com/en-us/dotnet/framework/install/how-to-determine-which-versions-are-installed)。

桥固定调用 Windows 自带的 64 位 Windows PowerShell 5.1：

```powershell
Test-Path "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
```

需要正常的用户桌面、Explorer 和计划任务服务。用户注销后不提供控制，重新登录后再自启；停留在开机登录界面、电脑睡眠或休眠时不可用。它不作为 Windows 服务运行，也不支持在无桌面的 Server Core 中执行 Ego。

### 3. 安装 Ego Lite（需要浏览器自动化时）

1. 从 [Ego Lite 官网](https://lite.ego.app/)下载 Windows 安装器，安装并打开 Ego Lite。
2. 在**将来运行桥的同一个 Windows 用户桌面**中完成首次引导；需要访问已登录网站时，在 Ego 中登录相应网站或按需导入浏览器资料。
3. 首次引导完成后重新打开终端，再检查命令和 Node 运行入口：

```powershell
Get-Command ego-browser
ego-browser nodejs -e "console.log('ego-browser ready')"
ego-browser skill
```

正常输出可能在 stderr 中；看到 ego-browser ready 表示 CLI 运行入口可用。skill 输出的是所装版本对应的浏览器 API 指引，Agent 编写 .mjs 时应遵循该指引。

本安装器尝试检测下列常见路径，也可以用安装向导的“浏览”选择实际 ego-browser.exe：

```powershell
$egoExe = Join-Path $env:USERPROFILE '.local\share\ego\active_version_dir\ego-browser.exe'
Test-Path -LiteralPath $egoExe
& $egoExe nodejs -e "console.log('ego-browser ready')"
```

请在交互桌面终端验证，不能用 SSH/服务会话中的执行结果替代。PATH 里的命令可能是启动脚本；桥配置需要真实 exe 路径。Chrome、Edge、普通 node.exe 都不能直接替代 Ego 的运行入口。

暂时不需要浏览器时，在安装向导中清空 Ego 路径，或命令行安装加 -SkipEgo；之后重新运行安装向导、选择同一个安装目录即可启用 Ego，现有 token 保留。Ego 是第三方软件，其账号、可用功能及使用条款以官网和所装版本为准，本项目不捆绑或代办。

### 4. 准备 Agent 与 Python 客户端（在 Agent 那端）

Agent 需要能够发出 HTTP 请求、读取你提供的密钥，并将长任务转为短请求轮询。不要求固定的 Agent 品牌或模型平台，也不自动配置某个模型提供商。

使用仓库内的 client.py 时，在 Agent 环境检查：

```bash
python3 --version
```

没有 Python 的 Debian/Ubuntu 环境可运行 `sudo apt-get update` 和 `sudo apt-get install python3`。其它发行版使用各自软件包管理器；Windows Agent 可从 [Python 官网](https://www.python.org/downloads/windows/)安装 Python 3，按[官方 Windows 指引](https://docs.python.org/3/using/windows.html)完成运行时安装后重开终端，确认 `python --version`。下文 Linux 命令的 python3，在 Windows 上按实际安装替换为 python 或 py -3。

仅复制 client.py 给 Agent 即可，无需复制 Windows 安装目录、token.txt 或本机 config.json。自动化调用需要 token 时，应由你通过可信通道交给 Agent 的密钥存储；`--token-file` 读取的是 **Agent 自己环境里已有的私密文件**，不是远程读取 Windows token.txt。

## 快速安装

1. 在 Windows 10/11 x64 上安装并登录 Tailscale，让本机与 Agent 加入同一 tailnet。
2. 双击 **NoraBridge-0.1.1-Setup-x64.exe**。选择唯一授权的 Agent 设备，确认安装目录、端口；Ego 路径可选。正常用户权限即可，不需要“以管理员运行”。
3. 点击“安装并启动”。安装器自动固定本机/Agent 的 Tailscale 设备 ID、IP 和网卡，生成独立的 48 字节随机 token，创建仅当前用户可管理的登录与恢复任务。
4. 将安装结果里的地址和 token 通过可信通道交给 Agent。安装器只显示 token 文件路径，不显示 token 值。

安装后先在本机查看 Status.ps1，确认配置的地址、任务状态和监听 PID；然后从选中的 Agent 设备执行下文的 health/exec 检查。**不要从本机请求 health 作为网络验收**，本机不在 Agent 来源白名单中，正确结果是 403。

默认安装到当前用户的 `%LOCALAPPDATA%\NoraBridge`；若 LocalAppData 使用 EFS 加密，则默认改用 `%USERPROFILE%\NoraBridge`。MVP 安装/运行目录不支持 EFS：发现加密目录会拒绝并说明，不会解密用户文件或修改加密策略。端口默认选择 17643 附近未占用的端口；同机存在旧专用版时使用另一个端口。每个安装实例使用独立的随机 ID，两个任务名为 NoraBridge-MVP-实例ID 与其 -Watchdog，停止/卸载不会操作专用版任务。

也可解压 ZIP、双击 Setup.cmd 使用命令行安装向导。配置未完成时程序不会放行任意 Agent，不会监听所有网卡。

运行要求：Windows x64、系统 .NET Framework 4.8+、Windows PowerShell 5.1、已登录的 Tailscale。运行不要求单独安装 Node.js、Python 或 npm。Ego 不是基础安装依赖：未配置时 exec/file 正常，POST /ego 返回 503；需要浏览器控制时自行安装 Ego Lite 并在安装器中指定路径。

安装器使用微软记录的 .NET Release >= 528040 检查 4.8 最低版本，见[微软版本检测说明](https://learn.microsoft.com/en-us/dotnet/framework/install/how-to-determine-which-versions-are-installed)。

## MVP 范围

- 可视安装向导、自动检测用户和 Tailscale、选择一台授权 Agent、可选 Ego。
- Bearer 鉴权、精确来源 IP 白名单、只绑定 Tailscale IPv4。
- PowerShell 命令、Ego .mjs、长任务轮询与无损输出分页、文件上传/下载。
- 当前用户交互会话登录自启、隐藏运行、独立每分钟 watchdog。
- 分日审计保留 14 天、启动/停止/状态/卸载脚本。

此 MVP 不含自动升级、签名证书、Windows 服务模式、多 Agent、IPv6、网页后台、macOS/Linux 或自动安装 Tailscale/Ego。暂不注册 Windows“已安装的应用”条目，使用下面的卸载脚本移除。支持目标为 Windows 10/11 x64；实际完成的系统、安装与隔离测试见 MVP-验收报告.md，不能把一台机器的测试当成所有 Windows 设备已验证。安装器有可见向导；后台启动不弹控制台；Ego 自己创建的浏览器任务窗口可能可见。

## 安装配置与控制

安装目录中：

| 文件/目录 | 用途 |
| --- | --- |
| config.json | 安装时生成的本机、Agent、端口、Ego、任务配置 |
| installation.json | 当前用户/安装实例标识，防止误停/误删其它目录 |
| token.txt | 仅当前用户可读写的随机密钥；重装同一实例默认保留 |
| runtime.json | 最近运行 PID、会话、地址与版本 |
| jobs | 原始脚本、输出、状态，默认保留供查询 |
| logs | UTC 按天审计，保留当天及之前 13 天 |
| runtime/control | 内嵌原生宿主与原子控制结果文件 |
| evidence | 本机显式自测的结果，不进入分发包 |

在安装目录中运行以下脚本即可，不需要管理员：

```powershell
.\Status.ps1
.\Stop.ps1
.\Start.ps1
.\Uninstall.ps1             # 删除两个任务，保留 token、日志和任务结果
.\Uninstall.ps1 -DeleteData # 确认不再需要数据后，删除该安装目录全部数据
```

从其它目录运行可以加 `-InstallDir '<安装目录>'`。脚本只接受带正确产品标识、实例 ID 和当前 SID 的安装目录；递归删除前校验目标，不跟随目录联接到安装目录外。

重新运行安装器可更换 Agent、端口或 Ego 路径。不会自动轮换或覆盖现有 token；更换设备/IP 后需明确重新配置，不会放宽白名单。

无人值守安装示例（Peer 填真实设备名、IP 或 ID）：

```powershell
.\Install.ps1 -NonInteractive -Peer '<Agent设备ID>' -Port 18743 -SkipEgo
# 仅安装、暂不启用任务：
.\Install.ps1 -NonInteractive -Peer '<Agent设备ID>' -SkipEgo -NoStart
```

没有 -Peer 的无人值守安装会失败；交互安装要求主动选择设备。指定端口已占用会失败，不会停止其它程序。

## 防火墙与网络

安装程序检查现有 Tailscale-In 规则，不修改防火墙全局策略、不开放公网、不映射端口。缺少现有允许规则时，远端连接可能被 Windows 防火墙或 tailnet ACL 阻止。

若需要，在**管理员 PowerShell**运行安装目录中的 Enable-Firewall.ps1；它只创建这个程序、这张 Tailscale 网卡、本机 IP、指定端口、唯一 Agent IP 的规则。脚本不会自动发起 UAC，不会添加所有来源允许规则。可选规则的删除也可能需要管理员；卸载会明确报告。

例如在管理员 PowerShell 中将路径改为实际安装目录后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<安装目录>\Enable-Firewall.ps1'
```

如果 tailnet 已有自定义访问策略，还要允许 **Agent → Windows 桥地址的所选 TCP 端口**。参见 [Tailscale grants 文档](https://tailscale.com/docs/features/access-control/grants)。以下只是待合并到现有 grants 数组的一条示例；两个 IP 和端口均应替换为实际值，不能直接覆盖整个 tailnet 策略：

```json
{
  "src": ["100.64.0.20"],
  "dst": ["100.64.0.10"],
  "ip": ["tcp:18743"]
}
```

从 Agent 可先执行 `tailscale ping <Windows的TailscaleIPv4>` 查看网络连通情况，但 ping 成功不等于 HTTP 端口和鉴权已通过。无需 Tailscale Funnel、路由器端口映射、公网 IP、SSH/VNC/RDP 服务；桥直接监听它自己的 Tailscale 地址。

所有 HTTP 请求都校验真实 TCP 来源和 Authorization，不信任 X-Forwarded-For，不接受 URL token。即使从本机带正确 token 访问，也会因不在 Agent 白名单返回 403。这是安全设计，不能通过添加本机放行来伪造远端验收。

本机 Tailscale 节点 ID、IPv4、网卡以及授权 Agent 节点 ID/IP 均固定校验。启动不匹配直接退出；运行期 10 秒异步检查，连续至少 6 次失败且距离上次成功至少 60 秒才退出。任何一次成功清零；不会回退到公网、LAN、0.0.0.0 或 localhost。

## API

全部请求带 `Authorization: Bearer <token>`；POST JSON 带 `Content-Type: application/json`。

| 接口 | 请求/结果 |
| --- | --- |
| GET /health | version、edition、pid、session、listen、allowed_peer、capabilities、active_jobs |
| POST /exec | `{ "command": "Write-Output 'hello'", "timeout_sec": 120 }` |
| POST /ego | `{ "script": "console.log('hello')", "timeout_sec": 120 }`；写入 .mjs 后 import |
| GET /exec/任务ID | 两类任务均可查询；可选 stdout_offset、stderr_offset |
| POST /file | `{ "path": "<用户目录内绝对路径>", "content_base64": "aGkK", "overwrite": false }` |
| GET /file?path=URL编码绝对路径 | 下载原始字节 |

20 秒内完成返回 200，否则返回 202、job_id 和初始输出。默认任务时限 1800 秒，可设 1..86400 秒，最多并行 4 个任务；HTTP 断开不取消已受理任务。命令/脚本上限 1 MiB，上传上限 1 MiB、下载上限 64 MiB，JSON 上限 3 MiB。

轮询时分别使用 next_stdout_offset / next_stderr_offset；每次每条流最多返回 256 KiB，直到终态且 has_more=false。拼接 base64 解码后的字节再解 UTF-8，可保证中文/emoji 跨页无损。初始 POST 响应的输出也要计入。state=completed 仅表示退出，成功还需 exit_code=0；创建失败为 failed，超时为 timed_out。

重试有副作用的 POST 应始终复用同一 `Idempotency-Key`。同 key/同 body 返回原任务，不重放；同 key/不同 body 返回 409。Ego 常将正常输出写入 stderr，长脚本强制超时可能没有刷出的输出。

file_root 默认是当前用户主目录；支持本地不同盘符，拒绝越界、UNC、设备名、ADS、别名、目录联接/符号链接、尾随点/空格，额外禁止直接读取安装目录中的 token/config。父目录须已存在，默认不覆盖文件。exec/ego 是完整当前用户权限的可信命令执行，不是文件沙箱；文件接口限制不限制命令本身的权限。

## Agent 客户端

可把 client.py 单独交给 Agent，它不含 token 或特定机器地址，只需要 Agent 侧 Python 3 标准库：

```bash
python3 client.py --url http://<本机TailscaleIPv4>:<端口> health
python3 client.py --url http://<本机TailscaleIPv4>:<端口> exec "Write-Output 'hello'"
python3 client.py --url http://<本机TailscaleIPv4>:<端口> ego ./task.mjs --timeout 180
```

token 默认无回显输入，也可通过 --token-file 读取已有私密文件；不通过命令行参数传 token 值，不写新副本。客户端禁用 HTTP_PROXY/HTTPS_PROXY，单次请求 28 秒以内，长任务靠短轮询。

### 首次连接的完整例子

以下 100.64.0.10、18743 和文件路径都是**示例**，先替换为安装结果。所有命令在授权 Agent 所在设备执行；无 token-file 时会提示无回显输入 token。

```bash
python3 client.py --url http://100.64.0.10:18743 health
python3 client.py --url http://100.64.0.10:18743 exec "Write-Output 'bridge-ok'"
python3 client.py --url http://100.64.0.10:18743 exec "Start-Sleep -Seconds 60; Write-Output 'after-60'" --timeout 120
```

期望结果：health 返回 version/pid/session；第二条输出 bridge-ok；第三条约 60 秒后输出 after-60，客户端内部自动轮询。需要非交互方式时，在动作名称 health/exec/ego **之前**加 `--token-file /已有的私密文件路径`。该文件及密钥值不得提交到仓库、Issue 或执行日志。

测试 Ego 时，在 Agent 保存一个 UTF-8 的 check.mjs，内容为 `console.log('ego-bridge-ok');`，然后执行：

```bash
python3 client.py --url http://100.64.0.10:18743 ego check.mjs --timeout 30
```

看到 ego-bridge-ok 且 exit_code=0 表示桥的 Ego 入口可用；真正操作页面前仍需完成 Ego 的首次引导和网站登录。客户端 upload/download 的参数说明可通过 `python3 client.py upload --help`、`python3 client.py download --help` 查看。

### 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 安装器没有 Agent 可选 | 确认两端 Tailscale 已登录同一 tailnet，status 能看到目标节点；点击刷新 |
| 连接超时/拒绝连接 | 查看 Status.ps1 的实际监听、用户是否已登录、Tailscale 是否在线，再检查 Windows 防火墙和 tailnet 策略 |
| HTTP 403 | 检查请求是否从选中的 Agent 节点发出；本机测试、容器出口、代理或其它设备都会被拒绝，正确 token 也不能绕过来源限制 |
| HTTP 401 | 使用该安装实例的 token；重新配置 Agent/端口默认保留密钥，安装到新目录会生成另一份密钥 |
| /ego 返回 503 | 安装并完成 Ego 引导，重新运行桥安装器设置真实 ego-browser.exe 路径 |
| Ego 任务挂住 | 检查同一用户的交互会话、Ego 是否完成引导、脚本是否兼容所装 Ego API；设置合理 timeout_sec，查询任务日志 |
| 脚本执行被 PowerShell 策略阻止 | 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<脚本路径>'` 单次运行；无需修改整机长期策略 |
| 提示 EFS 安装目录不支持 | 改为未加密的本地目录；不要解密用户已有文件来迁就安装 |
| Tailscale 节点/IP 改变后不启动 | 重新运行安装器，重新选择该设备；不会自动换身份或放宽白名单 |

不需要关闭杀毒软件或防火墙全局策略。后台不会自动解锁 Windows、代登录网站或让普通网页聊天获得 tailnet 网络权限。

## 原生宿主、恢复与诊断

基于专用版 EPERM 排查的设计：启动/ACL 校验及看护直接使用 Windows API/COM；exec 的 PowerShell 与 ego 都由内嵌 x64 原生宿主创建。节点/接口绑定和身份校验仍在常驻进程进行。

原生宿主以暂停状态、无控制台创建目标，指定 NUL stdin 与输出文件，仅将目标和后代加入每任务私有 Job；超时只终止私有 Job，父进程/宿主不加入它。控制结果使用原子文件。已成功执行的命令不重放；只对未创建出目标的 Win32 错误 5/32/33 做最多三次创建尝试。

startup_failed 与执行创建失败包含 errno、syscall、SID、会话、Node/libuv 版本、原生 Win32 阶段/错误码、父 stdio 只读复制检查与 Job/句柄快照。Windows 的 POSIX uid/gid 为 null。快照带时间，不冒充日后实时状态；不记录 token、argv、请求体或环境变量全集。审计摘要为命令 SHA-256 与字节数。

后台运行依赖用户已登录，要求同会话有当前用户所有的 explorer；Session 0 不运行。watchdog 每分钟检查一次，主任务未运行且未主动停用时请求恢复；保留停止标记和用户停用状态。睡眠/无交互登录/Tailscale 不就绪期间不保证恢复时限。旧任务重启后不自动重放，标记 interrupted。

## 构建与本机检查

源码使用 Node.js 24 x64 和系统 Framework64/v4.0.30319/csc.exe，运行端不需要它们的开发环境：

自行构建时，从 [Node.js 官方下载页](https://nodejs.org/en/download)选择 Windows x64 的 **24.x** 版本安装；本发布验证使用 24.21.0。重新打开 PowerShell，确认 `node --version` 和 `node -p process.arch` 分别为 v24.x 与 x64。.NET Framework 4.8 安装后须存在 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`。不需要 npm install 或额外下载资源注入工具。

在源码根目录运行；构建脚本默认查找 `%ProgramFiles%\nodejs\node.exe`，便携 Node 可用 `-NodePath '<node.exe绝对路径>'` 指定。GitHub 源码中的 Setup.cmd 面向构建后的分发目录，不应在未构建的源码根目录直接运行。

```powershell
.\package.ps1
node --test .\test\unit.cjs
```

构建输出 dist 下单 EXE 安装器、二进制 ZIP、源码 ZIP 和 SHA256SUMS.txt，使用明确文件白名单；不复制任何本机 token、config、日志、jobs 或 evidence。已验证的构建版本为 Node 24.21.0 x64，Node 的完整许可在 LICENSE-Node.txt。EXE 未签名，可能出现 Windows 信誉提示；MVP 不提供发布者签名保证。

安装后可在交互会话运行：

```powershell
.\nora-bridge.exe --data-dir '<安装目录>' --self-test
```

这是本机显式 CLI 自测：使用生产处理器但模拟 Agent 来源，不建立测试 HTTP 放行；真实执行 exec、35 秒后台任务、超时后执行、文件往返和可选 Ego CLI / Ego 超时后再次执行。结果在 evidence/self-test.json。跨设备网络验收需从选中的 Agent 发起真实请求。test/setup-harness.cs 是开发用 WinForms 集成测试：在屏幕外运行实际设备发现和安装处理器，不进入二进制分发包。
