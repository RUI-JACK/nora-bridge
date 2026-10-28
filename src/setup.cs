using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Drawing;
using System.Reflection;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class SetupProgram {
    public static string TemporaryRoot;
    public static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8*1024*1024 };
    public static string Quote(string value) {
        var result=new StringBuilder("\"");int slashes=0;
        foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1);result.Append(c);}else{result.Append('\\',slashes);result.Append(c);}slashes=0;}
        result.Append('\\',slashes*2);return result.Append('"').ToString();
    }
    public static string Unpack() {
        string parent=Path.GetFullPath(Path.GetTempPath());
        TemporaryRoot=Path.Combine(parent,"NoraBridge-Setup-"+Guid.NewGuid().ToString("N"));
        var sid=WindowsIdentity.GetCurrent().User;var acl=new DirectorySecurity();acl.SetOwner(sid);acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(TemporaryRoot,acl);
        string archive=Path.Combine(TemporaryRoot,"payload.zip"),payload=Path.Combine(TemporaryRoot,"payload");
        using(var resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("NoraBridge.Payload.zip")) {
            if(resource==null)throw new InvalidDataException("安装包资源缺失。");
            using(var file=File.Create(archive))resource.CopyTo(file);
        }
        using(var zip=ZipFile.OpenRead(archive))foreach(var entry in zip.Entries){string name=entry.FullName.Replace('\\','/');if(name.StartsWith("/")||name.Contains(":")||Array.Exists(name.Split('/'),p=>p==".."))throw new InvalidDataException("安装包路径无效。");}
        ZipFile.ExtractToDirectory(archive,payload);
        foreach(string required in new[]{"nora-bridge.exe","Install.ps1","Common.ps1","README.md"})if(!File.Exists(Path.Combine(payload,required)))throw new InvalidDataException("安装包文件不完整。");
        return payload;
    }
    public static void Cleanup() {
        if(TemporaryRoot==null||!Directory.Exists(TemporaryRoot))return;
        string parent=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        string full=Path.GetFullPath(TemporaryRoot);
        if(Path.GetDirectoryName(full).TrimEnd(Path.DirectorySeparatorChar)!=parent||!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(full),"^NoraBridge-Setup-[0-9a-f]{32}$"))return;
        try {Directory.Delete(full,true);}catch{}
    }
    [STAThread] static int Main(string[] args) {
        try {
            if(!Environment.Is64BitOperatingSystem||!Environment.Is64BitProcess)throw new PlatformNotSupportedException("需要 Windows x64。");
            string payload=Unpack();
            if(args.Length==2&&args[0]=="--self-check") {
                var files=new List<string>();foreach(string file in Directory.GetFiles(payload,"*",SearchOption.AllDirectories))files.Add(file.Substring(payload.Length+1));
                foreach(string forbidden in new[]{"token.txt","config.json","installation.json","runtime.json"})if(files.Exists(f=>Path.GetFileName(f).Equals(forbidden,StringComparison.OrdinalIgnoreCase)))throw new InvalidDataException("安装包意外包含本机配置或密钥。");
                File.WriteAllText(args[1],Json.Serialize(new {passed=true,files=files,embedded_payload=true,private_temp=true}),new UTF8Encoding(false));return 0;
            }
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupForm(payload));return 0;
        }catch(Exception e){if(args.Length==2&&args[0]=="--self-check"){File.WriteAllText(args[1],Json.Serialize(new {passed=false,error=e.Message}));return 1;}MessageBox.Show(e.Message,"Nora Bridge 安装未完成",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
        finally{Cleanup();}
    }
}

sealed class PeerChoice {
    public string Id,Name,Ip; public bool Online;
    public override string ToString(){return Name+"  ·  "+Ip+(Online?"":"  ·  离线");}
}
sealed class SetupForm:Form {
    readonly string payload;
    readonly ComboBox peer=new ComboBox();readonly TextBox installDirectory=new TextBox(),ego=new TextBox(),output=new TextBox();
    readonly NumericUpDown port=new NumericUpDown();readonly Button install=new Button(),refresh=new Button();readonly Label state=new Label();
    string tailscale;bool busy;
    public SetupForm(string directory) {
        payload=directory;Text="Nora Bridge · Windows x64 MVP";ClientSize=new Size(740,650);MinimumSize=new Size(720,650);StartPosition=FormStartPosition.CenterScreen;AutoScaleMode=AutoScaleMode.Dpi;Font=new Font("Microsoft YaHei UI",9F);
        var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),ColumnCount=1,RowCount=7};Controls.Add(layout);
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,224));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,32));
        layout.Controls.Add(new Label{Text="Nora Bridge",Font=new Font(Font.FontFamily,20,FontStyle.Bold),AutoSize=true},0,0);
        layout.Controls.Add(new Label{Text="让你的 Agent 通过 Tailscale 操作当前 Windows 用户的交互会话。",AutoSize=true,ForeColor=Color.DimGray},0,1);
        var fields=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=2,RowCount=4};fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));for(int n=0;n<4;n++)fields.RowStyles.Add(new RowStyle(SizeType.Absolute,52));layout.Controls.Add(fields,0,2);
        fields.Controls.Add(new Label{Text="授权 Agent",AutoSize=true,Margin=new Padding(0,8,0,0)},0,0);peer.DropDownStyle=ComboBoxStyle.DropDownList;peer.Dock=DockStyle.Fill;fields.Controls.Add(peer,1,0);
        fields.Controls.Add(new Label{Text="安装目录",AutoSize=true,Margin=new Padding(0,8,0,0)},0,1);string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);installDirectory.Text=Path.Combine((File.GetAttributes(local)&FileAttributes.Encrypted)!=0?Environment.GetFolderPath(Environment.SpecialFolder.UserProfile):local,"NoraBridge");fields.Controls.Add(BrowseRow(installDirectory,true),1,1);
        fields.Controls.Add(new Label{Text="监听端口",AutoSize=true,Margin=new Padding(0,8,0,0)},0,2);port.Minimum=1024;port.Maximum=65535;port.Value=AvailablePort();port.Width=120;fields.Controls.Add(port,1,2);
        fields.Controls.Add(new Label{Text="Ego（可选）",AutoSize=true,Margin=new Padding(0,8,0,0)},0,3);string candidate=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),@".local\share\ego\active_version_dir\ego-browser.exe");if(File.Exists(candidate))ego.Text=candidate;fields.Controls.Add(BrowseRow(ego,false),1,3);
        state.AutoSize=false;state.Dock=DockStyle.Fill;state.Text="正在读取 Tailscale 设备…";layout.Controls.Add(state,0,3);
        var actions=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.LeftToRight};install.Text="安装并启动";install.Width=130;install.Enabled=false;install.Click+=async(s,e)=>await Install();refresh.Text="刷新设备";refresh.Width=110;refresh.Click+=async(s,e)=>await Discover();actions.Controls.Add(install);actions.Controls.Add(refresh);layout.Controls.Add(actions,0,4);
        output.Multiline=true;output.ReadOnly=true;output.ScrollBars=ScrollBars.Vertical;output.Dock=DockStyle.Fill;output.BackColor=SystemColors.Window;output.Text="只允许你选择的一台 Agent 设备；每次请求都需要独立 token。\r\n未配置 Ego 时，exec/file 可用，ego 返回 503。";layout.Controls.Add(output,0,5);
        layout.Controls.Add(new Label{Text="当前用户安装 · Tailscale 私有地址 · 登录后隐藏运行 · 无需管理员",AutoSize=true,ForeColor=Color.DimGray,Margin=new Padding(0,10,0,0)},0,6);
        peer.SelectedIndexChanged+=(s,e)=>install.Enabled=!busy&&peer.SelectedItem is PeerChoice;
        Shown+=async(s,e)=>await Discover();FormClosing+=(s,e)=>{if(busy)e.Cancel=true;};
    }
    Control BrowseRow(TextBox text,bool folder) {
        var row=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=2};row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,76));text.Dock=DockStyle.Fill;row.Controls.Add(text,0,0);var button=new Button{Text="浏览…",Dock=DockStyle.Top};row.Controls.Add(button,1,0);
        button.Click+=(s,e)=>{if(folder){using(var d=new FolderBrowserDialog()){d.SelectedPath=text.Text;if(d.ShowDialog(this)==DialogResult.OK)text.Text=d.SelectedPath;}}else{using(var d=new OpenFileDialog{Filter="可执行文件 (*.exe)|*.exe"}){if(d.ShowDialog(this)==DialogResult.OK)text.Text=d.FileName;}}};return row;
    }
    static int AvailablePort(){var used=new HashSet<int>();foreach(var endpoint in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())used.Add(endpoint.Port);for(int n=17643;n<=17663;n++)if(!used.Contains(n))return n;return 17664;}
    static object Value(Dictionary<string,object> map,string key){object value;return map.TryGetValue(key,out value)?value:null;}
    static string TailIp(object values){var list=values as System.Collections.IEnumerable;if(list==null||values is string)return null;foreach(object v in list){System.Net.IPAddress address;if(System.Net.IPAddress.TryParse(Convert.ToString(v),out address)&&address.AddressFamily==System.Net.Sockets.AddressFamily.InterNetwork){byte[] bytes=address.GetAddressBytes();if(bytes[0]==100&&bytes[1]>=64&&bytes[1]<=127)return address.ToString();}}return null;}
    static string[] Run(string executable,string arguments,int timeout) {
        var info=new ProcessStartInfo(executable,arguments){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        info.EnvironmentVariables["PSModulePath"]=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),@"Documents\WindowsPowerShell\Modules")+";"+Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"WindowsPowerShell\Modules")+";"+Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\Modules");
        using(var process=Process.Start(info)){process.StandardInput.Close();var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();if(!process.WaitForExit(timeout)){process.Kill();throw new TimeoutException("操作超时。");}Task.WaitAll(stdout,stderr);return new[]{process.ExitCode.ToString(),stdout.Result,stderr.Result};}
    }
    async Task Discover() {
        if(busy)return;refresh.Enabled=false;install.Enabled=false;peer.Items.Clear();peer.Items.Add("请选择唯一授权的 Agent 设备");peer.SelectedIndex=0;
        try {
            tailscale=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"Tailscale\tailscale.exe");
            if(!File.Exists(tailscale)){foreach(string part in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')){try{string path=Path.Combine(part.Trim('"'),"tailscale.exe");if(File.Exists(path)){tailscale=Path.GetFullPath(path);break;}}catch{}}}
            if(!File.Exists(tailscale))throw new FileNotFoundException("请先安装并登录 Tailscale，再刷新设备。");
            var result=await Task.Run(()=>Run(tailscale,"status --json",8000));if(result[0]!="0")throw new InvalidOperationException("Tailscale 状态读取失败。");
            var data=SetupProgram.Json.Deserialize<Dictionary<string,object>>(result[1]);
            var self=Value(data,"Self") as Dictionary<string,object>;
            string address=self==null?null:TailIp(Value(self,"TailscaleIPs"));
            if(Convert.ToString(Value(data,"BackendState"))!="Running"||address==null)throw new InvalidOperationException("请先连接 Tailscale，取得 IPv4 地址后刷新。");
            var devices=Value(data,"Peer") as Dictionary<string,object>;
            if(devices!=null)foreach(var item in devices){var device=item.Value as Dictionary<string,object>;if(device==null)continue;string ip=TailIp(Value(device,"TailscaleIPs")),id=Convert.ToString(Value(device,"ID"));if(ip!=null&&!String.IsNullOrEmpty(id))peer.Items.Add(new PeerChoice{Id=id,Name=Convert.ToString(Value(device,"HostName")),Ip=ip,Online=Convert.ToBoolean(Value(device,"Online")??false)});}
            state.Text="仅绑定本机 Tailscale 地址："+address+"；请选择一台 Agent。";
        }catch(Exception e){state.Text=e.Message;}
        finally{refresh.Enabled=true;}
    }
    async Task Install() {
        var selected=peer.SelectedItem as PeerChoice;if(selected==null||busy)return;
        busy=true;install.Enabled=false;refresh.Enabled=false;state.Text="正在安装，创建当前用户配置与隐藏登录任务…";
        try {
            string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
            var args=new StringBuilder("-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+SetupProgram.Quote(Path.Combine(payload,"Install.ps1")));
            args.Append(" -NonInteractive -InstallDir "+SetupProgram.Quote(installDirectory.Text.Trim()));args.Append(" -Peer "+SetupProgram.Quote(selected.Id));args.Append(" -Port "+((int)port.Value));args.Append(" -TailscalePath "+SetupProgram.Quote(tailscale));
            if(String.IsNullOrWhiteSpace(ego.Text))args.Append(" -SkipEgo");else args.Append(" -EgoPath "+SetupProgram.Quote(ego.Text.Trim()));
            var result=await Task.Run(()=>Run(exe,args.ToString(),120000));output.Text=result[1]+Environment.NewLine+result[2];
            if(result[0]!="0")throw new InvalidOperationException("安装未完成。请查看下方详情；可以修正后重新安装。");
            state.Text="安装完成。已配置独立 token、登录自启和恢复任务。";install.Text="重新配置";
        }catch(Exception e){state.Text=e.Message;}
        finally{busy=false;refresh.Enabled=true;install.Enabled=peer.SelectedItem is PeerChoice;}
    }
}
