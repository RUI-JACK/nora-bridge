# Nora Bridge 通用安装 MVP 0.1.0 — 验收记录

日期：2026-10-28（JST）。这是独立于专用版 1.0.3 的通用安装分支。安装包不含实际用户名、Tailscale 地址、设备 ID、token 或本机配置。

## 测试范围

实测系统：Windows 11 x64，系统版本 10.0.26300，当前已登录的交互会话。构建使用 Node.js 24.21.0 x64 与系统 .NET Framework 编译器；安装后不依赖 Node 开发环境。安装目标使用当前用户主目录下含中文和空格的独立目录。

本机 API 检查使用生产请求处理器、模拟授权 Agent 的来源 IP、真实原生宿主与真实子进程，未新增任何测试监听或鉴权例外。另有真实 HTTP 自来源拒绝测试。此次没有从另一台电脑发起网络验收，不能把本机处理器结果当成远端通过。

## 已执行结果

| 项目 | 实际结果 |
| --- | --- |
| 源码自动检查 | `node --test test/unit.cjs`：10 项通过，0 失败；Python 客户端语法检查通过 |
| 通用配置 | 自动发现当前 Windows 用户、网卡与 tailnet；选择唯一 Agent；没有写死账户/IP/设备名 |
| 原生安装向导 | 在屏幕外运行真实 WinForms Shown/设备发现/安装处理器；未选择 Agent 时安装按钮不可用；选择后实际调用 Windows PowerShell 5.1 完成安装；界面渲染已检查 |
| 安装器资源 | `Setup.exe --self-check`：内嵌包解压和必需文件检查通过；不含 token/config/installation/runtime 文件；使用当前用户私有临时目录 |
| 启动与监听 | 计划任务在当前交互会话运行；只在配置的 Tailscale IPv4/独立端口监听；后台主进程 MainWindowHandle=0 |
| health 与鉴权 | 生产处理器 health=200，version=0.1.0；模拟错误来源=403、错误 token=401；真实 HTTP 从本机带正确 token 请求=403 |
| exec 短命令 | stdout=`mvp-中文-ok\r\n`，stderr=`stderr-ok\r\n`，exit_code=7，HTTP 200 |
| exec 后台任务 | 脚本等待 35 秒；HTTP 202 后轮询 31 次；实际约 36.334 秒完成；完整 stdout=`before\r\nafter-35\r\n`，exit_code=0 |
| exec 超时后恢复 | 2 秒时限的睡眠任务 state=timed_out；下一条命令 stdout=`after-timeout\r\n`、exit_code=0 |
| Ego 可选 | 未配置时 /ego=503，exec/file 仍通过；配置后 console 脚本正常执行，stderr=`nora-mvp-ego-ok\r\n\r\n`，exit_code=0 |
| Ego 超时后恢复 | 20 秒等待脚本设置 2 秒时限后 state=timed_out；下一条 exec 输出 `after-ego-timeout\r\n`，exit_code=0；父进程仍存活且 active_jobs=0 |
| file 往返 | 16 字节中文文本上传、下载逐字节一致；SHA-256=`85f89558da82dfbe8f13b4954d90a7ef49250e7bd7e04455b3c8bde52d30b414`；安装目录 token 和用户目录外路径被拒绝 |
| 同目录重新安装 | token 和随机实例 ID 均保留；token 为 48 随机字节的 96 位十六进制文本；ACL 仅当前用户有访问规则 |
| 异常恢复 | 强制终止独立测试实例后，审计出现 `watchdog_restart/action=started/previous_exit_code=-1`；约 6.25 秒后新 PID 恢复监听。此次刚好接近 watchdog 触发点，不代表每次都能在 6 秒恢复 |
| 重复实例 | 第二个实例以 exit 1 拒绝重复监听；原实例仍运行；未完成的测试 job 元数据没有被误标记 interrupted |
| 停止/启动 | Stop 后两个实例任务禁用、停止标记存在且监听消失；Start 后重新监听，密钥保持不变 |
| 安装拒绝条件 | 占用其它程序端口、未明确指定 Agent、EFS 加密目标目录：均失败退出且不创建目标目录；未停止其它实例 |
| 仅安装不启动 | `-NoStart` 后两个任务禁用、停止标记存在、没有监听 |
| 卸载 | 默认卸载删除两个任务并保留数据；`-DeleteData` 删除验证过的实例目录；目录联接外的哨兵文件仍完整，未跟随联接删除 |
| 现有部署隔离 | 专用版原 PID 与原监听在测试前后均保持；未操作专用版任务或 ego-run；测试安装与临时任务最终已移除 |

本机自测原始记录保存在开发目录 test-output 中，不进入安装包或源码 ZIP。对外分发只包含本报告的汇总，避免泄露本机 SID、Agent 清单和路径。

## 边界与后续验收

- 尚未在另一台电脑、另一账户、Windows 10、受企业策略管理的电脑或不同 DPI 上实测。不同盘符/用户目录配置已经单元测试，不能代替对应机器实测。
- 此次没有注销当前用户以触发真实登录流程；任务的交互登录类型、登录触发器与恢复运行已检查。其它电脑首次安装后应实际注销重登并由选中的 Agent 复测。
- 此次 Ego 实测为 nodejs 控制台脚本与强制超时，没有打开 example.com；浏览器页面能力仍依赖目标电脑安装的 Ego。
- 此次长命令实测 35 秒。实现允许最长 86400 秒并将输出落盘，但未在这个通用分支上重新执行十分钟测试。
- 后台 EXE 使用 GUI 子系统，原生宿主使用无控制台创建标志；本次窗口句柄检查为 0，没有对所有瞬时窗口做视频级监测。安装器本身有可见向导；Agent 主动打开的 GUI/浏览器可见性由相应程序决定。
- MVP 不支持 EFS 安装/运行目录；默认 AppData 加密时改用主目录下 NoraBridge。拒绝加密目录，不改变用户文件的加密策略。
- 未签名，无自动更新、服务模式、系统“已安装的应用”条目或内置 Tailscale/Ego 安装。防火墙默认不改；精确入站规则须按 README 单独由管理员添加，规则创建未在本轮改动系统策略验证。

## 交付

- `NoraBridge-0.1.0-Setup-x64.exe`：单文件可视安装器，内嵌运行时。
- `NoraBridge-0.1.0-windows-x64.zip`：相同运行时与命令行安装向导。
- `NoraBridge-0.1.0-source.zip`：源码、构建脚本、测试、文档与 Node 许可。
- `SHA256SUMS.txt`：三个交付文件的 SHA-256 校验值。

使用方法、API、停止/卸载命令和构建步骤见 README.md。不要复制已有专用版的 token/config 给其它电脑；每台电脑通过安装向导独立生成并绑定身份。
