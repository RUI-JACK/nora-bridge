// Windows-only process broker. No networking, elevation, shell command parsing,
// or token access. It runs as the same user/session as the bridge.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Web.Script.Serialization;

static class NoraNative {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    static readonly IntPtr Invalid = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved, desktop, title; public uint x,y,xs,ys,xc,yc,fill,flags;
        public short show,reserved2; public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessBasic { public IntPtr reserved1,peb,reserved2,reserved3,pid,parent; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int info,ref ExtendedLimit value,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int info,ref ExtendedLimit value,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SecurityAttributes attrs,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] data,int count,out IntPtr read);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr original,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessMitigationPolicy(IntPtr process,int policy,out uint flags,int size);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int info,ref ProcessBasic value,int size,IntPtr length);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int info,IntPtr data,int size,out int needed);

    static void Fail(string stage) { throw new NativeFailure(stage,Marshal.GetLastWin32Error()); }
    sealed class NativeFailure : Win32Exception { public readonly string Stage; public readonly int[] CreateErrors; public NativeFailure(string stage,int code,List<int> errors=null):base(code){Stage=stage;CreateErrors=errors==null?null:errors.ToArray();} }
    static T Get<T>(Dictionary<string,object> spec,string key) { return (T)Convert.ChangeType(spec[key],typeof(T)); }
    static Dictionary<string,object> ReadSpec(string file) { return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Utf8)); }
    static void WriteAtomic(string file,object value) {
        string temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
        using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.Read,4096,FileOptions.WriteThrough)) {
            byte[] data=Utf8.GetBytes(Json.Serialize(value));stream.Write(data,0,data.Length);stream.Flush(true);
        }
        if(File.Exists(file)) File.Replace(temp,file,null); else File.Move(temp,file);
    }
    static void Reply(object value) {
        byte[] data=Utf8.GetBytes(Json.Serialize(value));
        using(Stream output=Console.OpenStandardOutput()){output.Write(data,0,data.Length);output.Flush();}
    }
    static string OwnerSid(int pid) {
        IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)Fail("OpenProcess(owner)");
        IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
        try {
            if(!OpenProcessToken(process,8,out token))Fail("OpenProcessToken");
            int size;GetTokenInformation(token,1,IntPtr.Zero,0,out size);
            buffer=Marshal.AllocHGlobal(size);if(!GetTokenInformation(token,1,buffer,size,out size))Fail("GetTokenInformation");
            return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
        } finally {if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
    }
    static object Session(string root,int parentId) {
        var identity=WindowsIdentity.GetCurrent();string sid=identity.User.Value;
        using(var parent=Process.GetProcessById(parentId)) {
            if(parent.SessionId==0||OwnerSid(parentId)!=sid)throw new UnauthorizedAccessException("Interactive parent identity required");
            bool desktop=false;
            foreach(var explorer in Process.GetProcessesByName("explorer")) {
                using(explorer){try{if(explorer.SessionId==parent.SessionId&&OwnerSid(explorer.Id)==sid)desktop=true;}catch(Win32Exception){}}
            }
            if(!desktop)throw new UnauthorizedAccessException("No user-owned interactive explorer session");
            foreach(string item in new[]{root,Path.Combine(root,"token.txt")}) {
                if((File.GetAttributes(item)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Security path is a reparse point");
                FileSystemSecurity acl=Directory.Exists(item)?(FileSystemSecurity)Directory.GetAccessControl(item,AccessControlSections.Access|AccessControlSections.Owner):File.GetAccessControl(item,AccessControlSections.Access|AccessControlSections.Owner);
                if(!acl.AreAccessRulesProtected||acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid)throw new UnauthorizedAccessException("Unexpected ACL inheritance or owner");
                foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                    if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!=sid)throw new UnauthorizedAccessException("ACL grants another identity access");
                }
            }
            return new {user=identity.Name,sid=sid,session_id=parent.SessionId,interactive_desktop=true,process_start_ticks=parent.StartTime.ToUniversalTime().Ticks.ToString()};
        }
    }
    static object ComCall(object value,string name,params object[] args){return value.GetType().InvokeMember(name,System.Reflection.BindingFlags.InvokeMethod,null,value,args);}
    static object ComGet(object value,string name){return value.GetType().InvokeMember(name,System.Reflection.BindingFlags.GetProperty,null,value,null);}
    static object Watchdog(string root,string taskName) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(taskName,"^NoraBridge-MVP-[0-9a-f]{32}$"))throw new InvalidDataException("Invalid Nora task name");
        if(File.Exists(Path.Combine(root,"disabled")))return new {action="stop_marker"};
        object service=null,folder=null,task=null,running=null;
        try {
            service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));ComCall(service,"Connect");
            folder=ComCall(service,"GetFolder","\\");task=ComCall(folder,"GetTask",taskName);
            if(!Convert.ToBoolean(ComGet(task,"Enabled")))return new {action="disabled"};
            int state=Convert.ToInt32(ComGet(task,"State"));int result=Convert.ToInt32(ComGet(task,"LastTaskResult"));
            if(state==4)return new {action="already_running"};
            if(File.Exists(Path.Combine(root,"disabled")))return new {action="stop_marker"};
            running=ComCall(task,"Run",new object[]{null});
            return new {action="started",previous_state=state,previous_exit_code=result};
        }finally{foreach(object item in new[]{running,task,folder,service})if(item!=null&&Marshal.IsComObject(item))Marshal.FinalReleaseComObject(item);}
    }
    static object Stdio(Process process) {
        // Read-only inspection of x64 PEB/RTL_USER_PROCESS_PARAMETERS. Never close
        // a parent's original handle. Duplicate only for querying, then close COPY.
        var rows=new List<object>();IntPtr handle=OpenProcess(0x10|0x400|0x40,false,process.Id);
        if(handle==IntPtr.Zero)return new {read_ok=false,win32_error=Marshal.GetLastWin32Error()};
        try {
            var info=new ProcessBasic();int nt=NtQueryInformationProcess(handle,0,ref info,Marshal.SizeOf(info),IntPtr.Zero);
            if(nt!=0)return new {read_ok=false,ntstatus=nt};
            byte[] pointer=new byte[8];IntPtr read;
            if(!ReadProcessMemory(handle,IntPtr.Add(info.peb,0x20),pointer,8,out read))return new {read_ok=false,win32_error=Marshal.GetLastWin32Error()};
            var parameters=new IntPtr(BitConverter.ToInt64(pointer,0));byte[] values=new byte[24];
            if(!ReadProcessMemory(handle,IntPtr.Add(parameters,0x20),values,24,out read))return new {read_ok=false,win32_error=Marshal.GetLastWin32Error()};
            for(int i=0;i<3;i++) {
                long original=BitConverter.ToInt64(values,i*8);IntPtr copy;uint flags=0;
                bool ok=DuplicateHandle(handle,new IntPtr(original),GetCurrentProcess(),out copy,0,false,2);
                int error=ok?0:Marshal.GetLastWin32Error();uint type=0;
                if(ok){GetHandleInformation(copy,out flags);type=GetFileType(copy);CloseHandle(copy);}
                rows.Add(new {fd=i,handle=original,valid=ok,win32_error=error,file_type=type,duplicate_flags=flags});
            }
            return new {read_ok=true,handles=rows};
        } finally{CloseHandle(handle);}
    }
    static object ProcessDiagnostic(int pid) {
        try {
            using(var process=Process.GetProcessById(pid)) {
                bool inside;bool jobOk=IsProcessInJob(process.Handle,IntPtr.Zero,out inside);
                uint policy;bool policyOk=GetProcessMitigationPolicy(process.Handle,13,out policy,4);
                return new {pid=pid,session_id=process.SessionId,start_ticks=process.StartTime.ToUniversalTime().Ticks.ToString(),handle_count=process.HandleCount,
                    in_job=inside,job_query_ok=jobOk,child_policy=policy,child_policy_query_ok=policyOk,stdio=Stdio(process)};
            }
        } catch(Exception e){return new {pid=pid,diagnostic_error=e.GetType().Name};}
    }
    static object Diagnostic(int parent) {
        var job=new ExtendedLimit();bool ok=QueryInformationJobObject(IntPtr.Zero,9,ref job,(uint)Marshal.SizeOf(job),IntPtr.Zero);
        WindowsIdentity identity=WindowsIdentity.GetCurrent();
        return new {snapshot_at=DateTime.UtcNow.ToString("o"),user=identity.Name,sid=identity.User.Value,uid=(object)null,gid=(object)null,
            parent=ProcessDiagnostic(parent),host=ProcessDiagnostic(Process.GetCurrentProcess().Id),
            inherited_job=new {query_ok=ok,win32_error=ok?0:Marshal.GetLastWin32Error(),limit_flags=job.basic.flags,active_process_limit=job.basic.active}};
    }
    static object ErrorData(Exception error,int parent) {
        var native=error as NativeFailure;var win=error as Win32Exception;
        return new {stage=native==null?"native_host":native.Stage,win32_error=win==null?(int?)null:win.NativeErrorCode,hresult=error.HResult,create_errors=native==null?null:native.CreateErrors,
            error_type=error.GetType().Name,reason=error.Message,diagnostics=Diagnostic(parent)};
    }
    static Dictionary<string,object> Run(Dictionary<string,object> spec,string stdout,string stderr,string cancel,string infoFile) {
        string exe=Get<string>(spec,"exe"),args=Get<string>(spec,"args"),cwd=Get<string>(spec,"cwd");
        int timeout=Get<int>(spec,"timeout_sec"),parentId=Get<int>(spec,"parent_pid");
        if(!Path.IsPathRooted(exe)||!File.Exists(exe)||timeout<1||timeout>86400)throw new InvalidDataException("Invalid native process specification");
        using(var parent=Process.GetProcessById(parentId)) {
            if(parent.StartTime.ToUniversalTime().Ticks.ToString()!=Get<string>(spec,"parent_start_ticks"))throw new InvalidOperationException("Parent identity changed");
            IntPtr job=IntPtr.Zero,input=Invalid,output=Invalid,error=Invalid;
            var pi=new ProcessInfo();bool assigned=false;string state="running";object code=null;
            try {
                job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)Fail("CreateJobObjectW");
                var limit=new ExtendedLimit();limit.basic.flags=KILL_ON_JOB_CLOSE;
                if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)))Fail("SetInformationJobObject");
                var attrs=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),inherit=true};
                input=CreateFile("NUL",0x80000000,3,ref attrs,3,0,IntPtr.Zero);if(input==Invalid)Fail("CreateFileW(stdin)");
                output=CreateFile(stdout,0x40000000,3,ref attrs,2,0x80000000,IntPtr.Zero);if(output==Invalid)Fail("CreateFileW(stdout)");
                error=CreateFile(stderr,0x40000000,3,ref attrs,2,0x80000000,IntPtr.Zero);if(error==Invalid)Fail("CreateFileW(stderr)");
                var si=new StartupInfo{cb=Marshal.SizeOf(typeof(StartupInfo)),flags=0x100|1,show=0,input=input,output=output,error=error};
                var createErrors=new List<int>();
                for(int attempt=0;;attempt++) {
                    if(CreateProcess(exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT,IntPtr.Zero,cwd,ref si,out pi))break;
                    int createError=Marshal.GetLastWin32Error();createErrors.Add(createError);
                    // Retry only failures that returned NO process handle. Never
                    // replay an executed command, timeout, or completed child.
                    if(pi.process!=IntPtr.Zero||attempt>=2||(createError!=5&&createError!=32&&createError!=33))throw new NativeFailure("CreateProcessW",createError,createErrors);
                    Thread.Sleep(attempt==0?250:1000);
                }
                // Only this target and its descendants join the per-task job.
                // Neither the host nor bridge nor libuv's job is assigned/mutated.
                if(!AssignProcessToJobObject(job,pi.process))Fail("AssignProcessToJobObject(child)");
                assigned=true;
                if(infoFile!=null)WriteAtomic(infoFile,new {host_pid=Process.GetCurrentProcess().Id,child_pid=pi.pid,job_mode="child_only",parent_pid=parentId,session_id=Process.GetCurrentProcess().SessionId,create_attempts=createErrors.Count+1,create_errors=createErrors});
                if(ResumeThread(pi.thread)==0xffffffff)Fail("ResumeThread");
                CloseHandle(pi.thread);pi.thread=IntPtr.Zero;
                var clock=Stopwatch.StartNew();
                for(;;) {
                    uint wait=WaitForSingleObject(pi.process,100);
                    if(wait==0){uint exit;if(!GetExitCodeProcess(pi.process,out exit))Fail("GetExitCodeProcess");state="completed";code=unchecked((int)exit);break;}
                    if(wait==0xffffffff)Fail("WaitForSingleObject");
                    if(cancel!=null&&File.Exists(cancel)){state="cancelled";break;}
                    if(clock.Elapsed.TotalSeconds>=timeout){state="timed_out";break;}
                    parent.Refresh();if(parent.HasExited){state="interrupted";break;}
                }
                return new Dictionary<string,object>{{"state",state},{"exit_code",code},{"finished_at",DateTime.UtcNow.ToString("o")},{"child_pid",pi.pid},{"host_pid",Process.GetCurrentProcess().Id},{"job_mode","child_only"}};
            } finally {
                // Terminate and close only the privately owned job. If assignment
                // failed, terminate the suspended target using its exact handle.
                if(job!=IntPtr.Zero){if(assigned)TerminateJobObject(job,1);CloseHandle(job);}
                if(pi.process!=IntPtr.Zero){if(!assigned)TerminateProcess(pi.process,1);WaitForSingleObject(pi.process,5000);CloseHandle(pi.process);}
                if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);
                if(output!=Invalid){FlushFileBuffers(output);CloseHandle(output);}
                if(error!=Invalid){FlushFileBuffers(error);CloseHandle(error);}
                if(input!=Invalid)CloseHandle(input);
            }
        }
    }
    static int Main(string[] args) {
        int parent=0;
        try {
            if(args.Length==2&&args[0]=="--diagnose"){Reply(Diagnostic(Int32.Parse(args[1])));return 0;}
            if(args.Length==3&&args[0]=="--diagnose-file"){WriteAtomic(args[2],Diagnostic(Int32.Parse(args[1])));return 0;}
            if(args.Length==4&&args[0]=="--session-file"){parent=Int32.Parse(args[2]);WriteAtomic(args[3],Session(args[1],parent));return 0;}
            if(args.Length==5&&args[0]=="--watchdog-file"){parent=Int32.Parse(args[2]);WriteAtomic(args[4],Watchdog(args[1],args[3]));return 0;}
            if(args.Length!=2||(args[0]!="--capture"&&args[0]!="--worker"))return 2;
            bool worker=args[0]=="--worker";string location=Path.GetFullPath(args[1]);
            string specFile=worker?Path.Combine(location,"spec.json"):location;
            var spec=ReadSpec(specFile);parent=Get<int>(spec,"parent_pid");
            string stdout=worker?Path.Combine(location,"stdout.bin"):location+".out";
            string stderr=worker?Path.Combine(location,"stderr.bin"):location+".err";
            Dictionary<string,object> status;
            try{status=Run(spec,stdout,stderr,worker?Path.Combine(location,"cancel"):null,worker?Path.Combine(location,"worker.json"):null);}
            catch(Exception e){status=new Dictionary<string,object>{{"state","failed"},{"exit_code",null},{"finished_at",DateTime.UtcNow.ToString("o")},{"spawn_error",ErrorData(e,parent)}};}
            if(worker){WriteAtomic(Path.Combine(location,"status.json"),status);return status["state"].ToString()=="failed"?1:0;}
            byte[] outBytes=File.Exists(stdout)?File.ReadAllBytes(stdout):new byte[0];byte[] errBytes=File.Exists(stderr)?File.ReadAllBytes(stderr):new byte[0];
            if(outBytes.Length>1024*1024||errBytes.Length>1024*1024)throw new InvalidDataException("Native capture exceeds 1 MiB per stream");
            status["stdout_base64"]=Convert.ToBase64String(outBytes);status["stderr_base64"]=Convert.ToBase64String(errBytes);WriteAtomic(location+".result",status);return 0;
        }catch(Exception e){try{
            var value=new {state="failed",exit_code=(object)null,spawn_error=ErrorData(e,parent)};
            if(args.Length==2&&args[0]=="--capture")WriteAtomic(args[1]+".result",value);
            else if(args.Length>=3&&(args[0]=="--session-file"||args[0]=="--watchdog-file"||args[0]=="--diagnose-file"))WriteAtomic(args[args.Length-1],value);
            else Reply(value);
        }catch{}return 1;}
    }
}
