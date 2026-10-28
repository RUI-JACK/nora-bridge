'use strict';

// The service uses only Node built-ins. All child processes use hidden Windows
// startup flags. An embedded native host owns one child-only Job Object per task.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');
const VERSION = '0.1.1';
const EDITION = 'universal-mvp';
const HOME = path.resolve(os.homedir());
function dataDirectory(argv = process.argv) {
  const index = argv.indexOf('--data-dir');
  const fallback=path.join(HOME,'NoraBridge');
  const standard=path.join(process.env.LOCALAPPDATA || path.join(HOME,'AppData','Local'),'NoraBridge');
  const value = index < 0 ? (fs.existsSync(path.join(fallback,'installation.json'))&&!fs.existsSync(path.join(standard,'installation.json'))?fallback:standard) : argv[index+1];
  if (typeof value!=='string' || !/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || path.resolve(value)===path.parse(path.resolve(value)).root) throw new Error('A local absolute data directory is required');
  return path.resolve(value);
}
let ROOT = dataDirectory();
let SETTINGS,HOST,PEER,PORT,TS,EGO,FILE_ROOT;
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Codex may itself run under PowerShell 7. Its module path must not make Windows
// PowerShell 5.1 attempt to load incompatible PS7 Security/Utility modules.
const CHILD_ENV = { ...process.env, PSModulePath: [path.join(HOME,'Documents','WindowsPowerShell','Modules'),path.join(process.env.ProgramFiles || 'C:\\Program Files','WindowsPowerShell','Modules'),path.join(path.dirname(PS),'Modules')].join(';') };
delete CHILD_ENV.NODE_OPTIONS;
delete CHILD_ENV.NODE_PATH;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function tailnetIPv4(value) {
  if(typeof value!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return false;
  const a=value.split('.').map(Number);
  return a.every((n,i)=>n>=0&&n<=255&&String(n)===value.split('.')[i])&&a[0]===100&&a[1]>=64&&a[1]<=127;
}
function localPath(value) { return typeof value==='string'&&/^[A-Za-z]:[\\/]/.test(value)&&!value.includes('\0')&&!value.startsWith('\\\\')&&!value.includes(':',2); }
function validateConfiguration(c,root,userHome=HOME) {
  if(!c||c.schema_version!==1)throw new Error('Unsupported configuration schema; run Setup again');
  if(!localPath(c.owner_profile)||path.resolve(c.owner_profile).toLowerCase()!==path.resolve(userHome).toLowerCase()||!/^S-1-\d+(?:-\d+)+$/.test(c.owner_sid||''))throw new Error('Configuration belongs to another Windows user');
  if(!tailnetIPv4(c.listen_ip)||!tailnetIPv4(c.allowed_peer?.ip)||c.listen_ip===c.allowed_peer.ip)throw new Error('Only distinct Tailscale IPv4 addresses are allowed');
  if(!Number.isInteger(c.listen_port)||c.listen_port<1024||c.listen_port>65535)throw new Error('listen_port must be 1024..65535');
  if(typeof c.self_node_id!=='string'||!c.self_node_id||typeof c.allowed_peer.id!=='string'||!c.allowed_peer.id||typeof c.allowed_peer.name!=='string'||!c.allowed_peer.name)throw new Error('Pinned local and agent Tailscale identities are required');
  if(typeof c.tailscale_interface!=='string'||!c.tailscale_interface||!localPath(c.tailscale_path)||!c.tailscale_path.toLowerCase().endsWith('.exe'))throw new Error('An absolute Tailscale executable and interface are required');
  if(c.ego_path!==null&&(!localPath(c.ego_path)||!c.ego_path.toLowerCase().endsWith('.exe')))throw new Error('ego_path must be an absolute executable or null');
  if(!localPath(c.file_root))throw new Error('file_root must be local and absolute');
  const relative=path.relative(path.resolve(userHome),path.resolve(c.file_root));
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('file_root must stay inside the current user profile');
  if(!/^[0-9a-f]{32}$/.test(c.instance_id||'')||!localPath(c.install_dir)||path.resolve(c.install_dir).toLowerCase()!==path.resolve(root).toLowerCase())throw new Error('Installation identity or data directory mismatch');
  const task='NoraBridge-MVP-'+c.instance_id;
  if(c.task_name!==task||c.watchdog_task_name!==task+'-Watchdog')throw new Error('Task identity does not match this installation');
  return c;
}
function configure(c,root=ROOT) {
  SETTINGS=validateConfiguration(c,root);ROOT=path.resolve(root);HOST=c.listen_ip;PEER=c.allowed_peer.ip;PORT=c.listen_port;TS=c.tailscale_path;EGO=c.ego_path;FILE_ROOT=path.resolve(c.file_root);
}
function loadConfiguration() {
  const file=path.join(ROOT,'config.json');
  if(!fs.existsSync(file))throw new Error('Not installed: run Setup.exe or Install.ps1 first');
  const c=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'installation.json'),'utf8').replace(/^\uFEFF/,''));
  if(manifest.product!=='NoraBridge.Universal.MVP'||manifest.instance_id!==c.instance_id||manifest.owner_sid!==c.owner_sid||path.resolve(manifest.root).toLowerCase()!==ROOT.toLowerCase())throw new Error('Not a matching Nora Bridge MVP installation');
  configure(c);
}
let nativeHostPath;
let nativeDiagnostics;
function nodeDiagnostics() {
  return { pid: process.pid, ppid: process.ppid, platform: process.platform, arch: process.arch,
    node: process.version, uv: process.versions.uv, sea: sea.isSea(), uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    stdio: [0,1,2].map(fd => { try { const s=fs.fstatSync(fd); return {fd,valid:true,is_pipe:s.isFIFO(),is_file:s.isFile(),is_character:s.isCharacterDevice()}; } catch(e){return {fd,valid:false,error:e.code};} }) };
}
function nativeHost() {
  if (nativeHostPath) return nativeHostPath;
  if (!sea.isSea()) { nativeHostPath=path.join(__dirname,'..','build','native-host.exe'); return nativeHostPath; }
  const bytes=Buffer.from(sea.getAsset('native-host.exe'));
  const dir=path.join(ROOT,'runtime');
  fs.mkdirSync(dir,{recursive:true});
  const target=path.join(dir,'native-host-'+hash(bytes).slice(0,16)+'.exe');
  if (!fs.existsSync(target) || hash(fs.readFileSync(target))!==hash(bytes)) {
    const temp=target+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,target);
  }
  nativeHostPath=target;
  return target;
}
function spawnDiagnostic(error, options = {}) {
  error.spawn_diagnostics = { node: nodeDiagnostics(), native: nativeDiagnostics || null,
    options: {windows_hide:true,detached:false,uid:null,gid:null,...options} };
  return error;
}
function getNativeDiagnostics() {
  if (nativeDiagnostics) return nativeDiagnostics;
  const dir=path.join(ROOT,'control');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'diag-'+crypto.randomUUID()+'.json');
  try {
    execFileSync(nativeHost(),['--diagnose-file',String(process.pid),file],{windowsHide:true,env:CHILD_ENV,stdio:'ignore',timeout:10000});
    nativeDiagnostics=JSON.parse(fs.readFileSync(file,'utf8'));
    return nativeDiagnostics;
  } catch(e){throw spawnDiagnostic(e,{stage:'native_diagnostics',stdio:'ignore_file_ipc'});}
  finally{try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
const atomicJSON = (file, data) => {
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx' });
  fs.renameSync(tmp, file);
};

function operationalError(event, error) {
  if(!fs.existsSync(path.join(ROOT,'installation.json')))return;
  const dir = path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const cutoff = Date.parse(now.slice(0, 10)) - 13 * 86400000;
  for (const name of fs.readdirSync(dir)) {
    if (/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && Date.parse(name.slice(6,16)) < cutoff) fs.unlinkSync(path.join(dir, name));
  }
  fs.appendFileSync(path.join(dir, `audit-${now.slice(0,10)}.jsonl`), JSON.stringify({ time: now, event, version: VERSION, pid:process.pid, ppid:process.ppid,
    error: error.code || error.name, errno:error.errno ?? null, syscall:error.syscall ?? null, uid:null,gid:null,
    reason: String(error.message).split('\n')[0].slice(0,180), diagnostics:error.spawn_diagnostics || {node:nodeDiagnostics(),native:nativeDiagnostics || null}, native_error:error.native_error || null, exit_code: 1 }) + '\n');
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function nativeControl(mode, args) {
  // Session validation and scheduler control use Windows APIs directly: neither
  // path creates powershell.exe, so its refusal cannot disable health/watchdog.
  const dir=path.join(ROOT,'control');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,crypto.randomUUID()+'.json');
  try {
    let launchError;
    try {
      execFileSync(nativeHost(),[mode,...args,file],{windowsHide:true,env:CHILD_ENV,stdio:'ignore',timeout:12000});
    } catch(e){launchError=e;}
    if(!fs.existsSync(file))throw spawnDiagnostic(launchError || new Error('Native control returned no result'),{stage:mode,stdio:'ignore_file_ipc'});
    const result=JSON.parse(fs.readFileSync(file,'utf8'));
    if(result.state==='failed') {
      const error=new Error('Native session/scheduler control failed');error.code='NATIVE_CONTROL_FAILED';error.errno=result.spawn_error?.win32_error ?? null;
      error.syscall=result.spawn_error?.stage || mode;error.native_error=result.spawn_error;
      throw spawnDiagnostic(error,{stage:mode,stdio:'ignore_file_ipc'});
    }
    if(launchError)throw spawnDiagnostic(launchError,{stage:mode,stdio:'ignore_file_ipc'});
    return result;
  } finally {try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}

function validateTailnet() {
  const status = JSON.parse(execFileSync(TS, ['status', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }));
  return validateTailnetState(status);
}

function validateTailnetState(status) {
  const peers = Object.values(status.Peer || {}).filter(p => p.ID===SETTINGS.allowed_peer.id);
  const addresses = Object.entries(os.networkInterfaces()).filter(([name]) => name.toLowerCase() === SETTINGS.tailscale_interface.toLowerCase()).flatMap(([, values]) => values);
  if (status.BackendState !== 'Running' || status.Self?.ID!==SETTINGS.self_node_id || !status.Self?.TailscaleIPs?.includes(HOST) ||
      !addresses.some(a => a.address === HOST && a.family === 'IPv4') ||
      peers.length !== 1 || !peers[0].TailscaleIPs?.includes(PEER)) {
    throw new Error('Tailscale identity/address mismatch; refusing to listen');
  }
  return { hostname: peers[0].HostName, ip: PEER, online: !!peers[0].Online };
}

function validateTailnetAsync() {
  // Monitoring must never block HTTP handling while waiting for tailscaled.
  return new Promise((resolve, reject) => {
    execFile(TS, ['status', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(validateTailnetState(JSON.parse(stdout))); } catch (e) { reject(e); }
    });
  });
}

function createTailnetMonitor({ check = validateTailnetAsync, audit, onLost,
  now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval }) {
  const intervalMs = 10000;
  const threshold = 6;
  const windowMs = 60000;
  let lastSuccess = now();
  let failures = 0;
  let busy = false;
  let stopped = false;
  function stop() { stopped = true; clearTimer(timer); }
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      let error;
      try { await check(); } catch (e) { error = e; }
      if (stopped) return;
      if (!error) {
        if (failures) audit({ event: 'tailscale_recovered', previous_failures: failures, since_last_success_ms: Math.round(now() - lastSuccess), exit_code: null });
        failures = 0;
        lastSuccess = now();
        return;
      }
      failures++;
      const elapsed = Math.round(now() - lastSuccess);
      // Do not log CLI stdout/stderr: status output contains unrelated peer data.
      const details = { consecutive_failures: failures, failure_threshold: threshold,
        since_last_success_ms: elapsed, minimum_failure_window_ms: windowMs,
        error_code: error.code || error.name,
        reason: error.killed ? 'status_command_timeout' : error instanceof SyntaxError ? 'invalid_status_json' : error.message === 'Tailscale identity/address mismatch; refusing to listen' ? 'identity_or_interface_mismatch' : 'status_check_failed' };
      audit({ event: 'tailscale_check_failed', ...details, exit_code: null });
      // Six normal 10-second checks cover a full minute since the last successful
      // validation. Require BOTH count and elapsed time; one success resets both.
      if (failures >= threshold && elapsed >= windowMs) {
        audit({ event: 'tailscale_lost', ...details, exit_code: 1 });
        stop();
        onLost();
      }
    } finally { busy = false; }
  }
  const timer = setTimer(() => { tick().catch(e => { operationalError('monitor_failed', e); process.exit(1); }); }, intervalMs);
  return { tick, stop };
}

function watchdog() {
  if (fs.existsSync(path.join(ROOT, 'disabled'))) return;
  const result = nativeControl('--watchdog-file',[ROOT,String(process.pid),SETTINGS.task_name]);
  // Successful periodic checks stay quiet; only recovery/actionable failure is
  // audited. This executable mode has no HTTP listener and never reads the token.
  if (result.action === 'started') {
    const bridge = createBridge({ token: '', session: {}, recoverJobs: false });
    bridge.audit({ event: 'watchdog_restart', ...result, pid: process.pid, exit_code: null });
  }
}

function validateSessionAndACL(root) {
  // Reject session 0 and an ACL granting any other SID access, including inherited
  // grants. ACL checking runs locally; neither bearer nor commands enter its argv.
  return nativeControl('--session-file',[root,String(process.pid)]);
}

function createBridge({ root = ROOT, token, session, syncMs = 20000, recoverJobs = true, spawnProcess = spawn }) {
  const jobsDir = path.join(root, 'jobs');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const active = new Map();
  let stopping = false;
  let logDay = '';

  function audit(event) {
    const time = new Date().toISOString();
    const day = time.slice(0, 10); // UTC, explicit and stable across DST.
    if (day !== logDay) {
      logDay = day;
      const cutoff = Date.parse(day) - 13 * 86400000;
      for (const name of fs.readdirSync(logsDir)) {
        if (/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && Date.parse(name.slice(6, 16)) < cutoff) {
          fs.unlinkSync(path.join(logsDir, name));
        }
      }
    }
    // Fail closed if audit cannot be persisted. Do not log bodies, headers,
    // query strings or command text: they can contain credentials.
    fs.appendFileSync(path.join(logsDir, `audit-${day}.jsonl`), JSON.stringify({ time, ...event }) + '\n');
  }

  const jobPath = id => {
    if (!JOB_ID.test(id)) throw new ApiError(404, 'Unknown job');
    return path.join(jobsDir, id);
  };
  function metadata(id) {
    try { return JSON.parse(fs.readFileSync(path.join(jobPath(id), 'meta.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw new ApiError(404, 'Unknown job'); throw e; }
  }
  function status(id) {
    const meta = metadata(id);
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(jobPath(id), 'status.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { ...meta, ...(result || { state: 'running', exit_code: null }) };
  }

  // Positions are raw byte offsets. UTF-8 text and exact base64 bytes are both
  // returned: a caller can concatenate base64-decoded chunks without corrupting
  // a multibyte character split by a concurrent write or a page boundary.
  function readOutput(id, name, offset) {
    const file = path.join(jobPath(id), name + '.bin');
    const size = fs.statSync(file).size;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new ApiError(400, 'Invalid output offset');
    const buf = Buffer.alloc(Math.min(size - offset, 256 * 1024));
    const fd = fs.openSync(file, 'r');
    let count;
    try { count = fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    const data = buf.subarray(0, count);
    return { text: data.toString('utf8'), base64: data.toString('base64'), next: offset + count, size };
  }
  function snapshot(id, out = 0, err = 0) {
    // Read state first: terminal state is only written after output is flushed.
    const s = status(id);
    const a = readOutput(id, 'stdout', out);
    const b = readOutput(id, 'stderr', err);
    return { ...s, stdout: a.text, stderr: b.text, stdout_base64: a.base64, stderr_base64: b.base64,
      stdout_offset: out, stderr_offset: err, next_stdout_offset: a.next, next_stderr_offset: b.next,
      stdout_bytes: a.size, stderr_bytes: b.size, has_more: a.next < a.size || b.next < b.size,
      poll_url: `/exec/${id}` };
  }

  // Recover metadata after a bridge restart. Workers monitor their original
  // parent's creation time and kill their own job trees when that parent dies.
  // Never replay an interrupted command automatically.
  function recoverInterruptedJobs() {
  for (const id of fs.readdirSync(jobsDir).filter(id => JOB_ID.test(id))) {
    const dir = jobPath(id);
    if (fs.existsSync(path.join(dir, 'meta.json')) && !fs.existsSync(path.join(dir, 'status.json'))) {
      atomicJSON(path.join(dir, 'status.json'), { state: 'interrupted', exit_code: null, finished_at: new Date().toISOString(), reason: 'Bridge restarted; command was not replayed' });
      audit({ event: 'execution_recovered_interrupted', job_id: id, exit_code: null });
    }
  }
  }
  if(recoverJobs)recoverInterruptedJobs();

  function startJob(kind, body, source, requestId, persistKey = () => {}) {
    if (stopping) throw new ApiError(503, 'Service stopping');
    if (active.size >= 4) throw new ApiError(429, 'At most four concurrent jobs');
    if(kind==='ego'&&(!EGO||!fs.existsSync(EGO)))throw new ApiError(503,'Ego is not configured or missing; rerun Setup to enable it');
    const text = kind === 'exec' ? body.command : body.script;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) throw new ApiError(400, `Nonempty ${kind === 'exec' ? 'command' : 'script'} required, maximum 1 MiB`);
    const timeout = body.timeout_sec ?? 1800;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new ApiError(400, 'timeout_sec must be an integer between 1 and 86400');
    const id = crypto.randomUUID();
    const dir = jobPath(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'stdout.bin'), '');
    fs.writeFileSync(path.join(dir, 'stderr.bin'), '');
    const meta = { job_id: id, kind, started_at: new Date().toISOString(), timeout_sec: timeout, source_ip: source,
      request_id: requestId, summary: { sha256: hash(text), utf8_bytes: Buffer.byteLength(text) } };
    let exe, args;
    if (kind === 'exec') {
      exe = PS;
      fs.writeFileSync(path.join(dir, 'command.ps1'), '\uFEFF' + text, 'utf8');
      const prelude = "$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; Set-Location -LiteralPath '"+HOME.replace(/'/g,"''")+"'; ";
      // The text stays in a UTF-8 BOM script, never in shell arguments or logs.
      const entry = prelude + `& '${path.join(dir, 'command.ps1').replace(/'/g, "''")}'; $ok=$?; if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}; if(-not $ok){exit 1}`;
      args = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(entry, 'utf16le').toString('base64')}`;
    } else {
      exe = EGO;
      const script = path.join(dir, 'script.mjs');
      fs.writeFileSync(script, text, 'utf8');
      args = `nodejs -e "await import('${pathToFileURL(script).href.replace(/'/g,'%27')}')"`;
    }
    atomicJSON(path.join(dir, 'meta.json'), meta);
    atomicJSON(path.join(dir, 'spec.json'), { exe, args, timeout_sec: timeout, parent_pid: process.pid, parent_start_ticks: session.process_start_ticks, cwd: HOME });
    // Commit the retry mapping BEFORE any external side effect can start.
    // A crash after this point leaves an interrupted task, never an auto-replay.
    persistKey(id);
    audit({ event: 'execution_start', source_ip: source, interface: '/' + kind, job_id: id, request_id: requestId, summary: meta.summary, exit_code: null });
    let child;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    active.set(id, { child, done, dir });
    const finish = (error) => {
      try {
        if (!fs.existsSync(path.join(dir, 'status.json'))) atomicJSON(path.join(dir, 'status.json'), { state: 'failed', exit_code: null, finished_at: new Date().toISOString(), reason: error ? 'Could not start native worker' : 'Native worker exited without status',
          ...(error?{spawn_error:{code:error.code,errno:error.errno ?? null,syscall:error.syscall ?? null,diagnostics:spawnDiagnostic(error,{stage:'native_worker',stdio:'ignore'}).spawn_diagnostics}}:{}) });
        const s = status(id);
        audit({ event: 'execution_end', source_ip: source, interface: '/' + kind, request_id: requestId, job_id: id, summary: meta.summary, state: s.state, exit_code: s.exit_code,
          ...(s.spawn_error?{spawn_error:s.spawn_error}:{}) });
      } catch (e) { fatal(e); }
      active.delete(id);
      resolveDone();
    };
    try {
      child=spawnProcess(nativeHost(),['--worker',dir],{windowsHide:true,env:CHILD_ENV,stdio:'ignore',cwd:HOME});
      active.get(id).child=child;
      child.once('error', finish);
      child.once('close', () => { if (active.has(id)) finish(); });
    } catch(e) { finish(e); }
    // This timer is independent of the request's socket. Client disconnects never
    // terminate work; idempotency keys prevent re-execution after a lost response.
    const completion = new Promise(resolve => {
      const timer = setTimeout(resolve, syncMs);
      done.then(() => { clearTimeout(timer); resolve(); });
    }).then(() => snapshot(id));
    return { id, completion };
  }

  async function readJSON(req) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Content-Type application/json required');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) throw new ApiError(413, 'JSON body exceeds 3 MiB');
      chunks.push(chunk);
    }
    try {
      const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
      return obj;
    } catch { throw new ApiError(400, 'Invalid JSON object'); }
  }

  function safePath(input, writing = false) {
    if (typeof input !== 'string' || !input || input.includes('\0') || input.includes(':', 2) || /[<>"|?*]/.test(input) || input.startsWith('\\\\') || !/^[A-Za-z]:[\\/]/.test(input)) throw new ApiError(403, 'Only absolute paths inside the configured user file root are allowed');
    const full = path.resolve(input);
    const relative = path.relative(FILE_ROOT, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError(403, 'Path outside user directory');
    const parts = full.slice(3).split(path.sep);
    if (parts.some(p => !p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new ApiError(403, 'Windows special paths forbidden');
    if ([ROOT,root].some(excluded=>full.toLowerCase()===excluded.toLowerCase()||full.toLowerCase().startsWith(excluded.toLowerCase()+path.sep))) throw new ApiError(403, 'Bridge internals are excluded from file API');
    // Reject symlinks/junctions and aliases whose real path escapes HOME, including
    // existing ancestors of a new file. Remote arbitrary exec is intentionally a
    // trusted-user capability; this path gate is not a sandbox for /exec or /ego.
    let cursor = path.parse(full).root;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) throw new ApiError(403, 'Reparse path forbidden');
        const real = fs.realpathSync.native(cursor).toLowerCase();
        const normal = cursor.toLowerCase();
        if (real !== normal) throw new ApiError(403, 'Path alias or reparse target forbidden');
      } catch (e) {
        if (e.code === 'ENOENT' && writing && i === parts.length - 1) break;
        if (e.code === 'ENOENT') throw new ApiError(404, 'File or parent directory not found');
        throw e;
      }
    }
    return full;
  }

  function send(res, code, obj) {
    if (res.destroyed) return;
    const data = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }

  // Handler is exported for offline acceptance with an explicitly simulated
  // source address. Production has no test mode, local-IP exemption or backdoor.
  async function handle(req, res) {
    const requestId = crypto.randomUUID();
    const source = req.socket.remoteAddress;
    let endpoint = 'invalid-url';
    let code = 500;
    const start = Date.now();
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      endpoint = url.pathname;
      audit({ event: 'request_start', source_ip: source, interface: endpoint, method: req.method, request_id: requestId, exit_code: null });
      if (source !== PEER) throw new ApiError(403, 'Source IP forbidden');
      const auth = req.headers.authorization;
      const expected = Buffer.from('Bearer ' + token);
      const received = Buffer.from(typeof auth === 'string' ? auth : '');
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new ApiError(401, 'Invalid bearer token');
      if (req.headers['transfer-encoding'] && req.headers['content-length']) throw new ApiError(400, 'Ambiguous request framing');
      if (req.method === 'GET' && endpoint === '/health') {
        code = 200;
        send(res, code, { version: VERSION, edition:EDITION,pid: process.pid, session, current_time: new Date().toISOString(), listen: `${HOST}:${PORT}`, allowed_peer: { hostname: SETTINGS.allowed_peer.name, ip: PEER },capabilities:{exec:true,file:true,ego:!!EGO&&fs.existsSync(EGO)}, active_jobs: active.size });
      } else if (req.method === 'POST' && (endpoint === '/exec' || endpoint === '/ego')) {
        const body = await readJSON(req);
        const key = req.headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(key))) throw new ApiError(400, 'Invalid Idempotency-Key');
        const digest = hash(JSON.stringify({ endpoint, body }));
        const record = key ? path.join(jobsDir, 'key-' + hash(key) + '.json') : null;
        let job;
        if (record && fs.existsSync(record)) {
          const prior = JSON.parse(fs.readFileSync(record, 'utf8'));
          if (prior.digest !== digest) throw new ApiError(409, 'Idempotency key was used with another body');
          job = snapshot(prior.id);
        } else {
          // Reserve synchronously before startJob yields; a retry while the first
          // request waits sees the already-persisted job rather than duplicating it.
          const pending = startJob(endpoint.slice(1), body, source, requestId,
            id => { if (record) atomicJSON(record, { id, digest }); });
          job = await pending.completion;
        }
        code = job.state === 'running' ? 202 : 200;
        send(res, code, job);
      } else if (req.method === 'GET' && /^\/(exec|ego)\/[^/]+$/.test(endpoint)) {
        const offset = name => {
          const value = url.searchParams.get(name) ?? '0';
          if (!/^\d+$/.test(value)) throw new ApiError(400, 'Invalid output offset');
          return Number(value);
        };
        const job = snapshot(endpoint.split('/')[2], offset('stdout_offset'), offset('stderr_offset'));
        code = 200; send(res, code, job);
      } else if (req.method === 'POST' && endpoint === '/file') {
        const body = await readJSON(req);
        if (typeof body.content_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content_base64)) throw new ApiError(400, 'Canonical content_base64 required');
        const file = safePath(body.path, true);
        const data = Buffer.from(body.content_base64, 'base64');
        if (data.length > 1024 * 1024) throw new ApiError(413, 'File upload exceeds 1 MiB');
        const tmp = path.join(path.dirname(file), '.nora-' + crypto.randomUUID() + '.tmp');
        try {
          fs.writeFileSync(tmp, data, { flag: 'wx' });
          safePath(body.path, true);
          if (!body.overwrite && fs.existsSync(file)) throw new ApiError(409, 'File exists; overwrite:true required');
          if (body.overwrite === true) fs.renameSync(tmp, file);
          else { fs.linkSync(tmp, file); fs.unlinkSync(tmp); }
        } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
        code = 200; send(res, code, { bytes: data.length, sha256: hash(data) });
      } else if (req.method === 'GET' && endpoint === '/file') {
        const file = safePath(url.searchParams.get('path'));
        const fd = fs.openSync(file, 'r');
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) { fs.closeSync(fd); throw new ApiError(413, 'Downloads require a regular file up to 64 MiB'); }
        code = 200;
        res.writeHead(code, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const stream = fs.createReadStream(file, { fd, autoClose: true });
        await new Promise((resolve, reject) => { stream.once('error', reject); res.once('finish', resolve); res.once('close', resolve); stream.pipe(res); });
        stream.destroy();
      } else throw new ApiError(404, 'Unknown endpoint or method');
    } catch (e) {
      code = e.status || 500;
      send(res, code, { error: e.status ? e.message : 'Internal error; see local audit', request_id: requestId });
    } finally {
      try { audit({ event: 'request_end', source_ip: source, interface: endpoint, method: req.method, request_id: requestId, http_status: code, duration_ms: Date.now() - start, exit_code: null }); }
      catch (e) { fatal(e); }
    }
  }

  function fatal(e) {
    try { operationalError('fatal', e); } catch {}
    if (require.main === module || sea.isSea()) process.exit(1);
    throw e;
  }
  async function stop() {
    stopping = true;
    for (const [, item] of active) fs.writeFileSync(path.join(item.dir, 'cancel'), '');
    await Promise.race([Promise.all([...active.values()].map(item => item.done)), wait(5000)]);
  }
  return { handle, snapshot, audit, stop, safePath, active, recoverInterruptedJobs };
}

async function main() {
  if(process.argv.includes('--version')){console.log(JSON.stringify({version:VERSION,edition:EDITION}));return;}
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Windows x64 is required');
  loadConfiguration();
  // An owner-only stop marker also works when Windows' inherited task DACL lets
  // ordinary user tokens may have different Task Scheduler management rights.
  // Exit successfully so Task Scheduler does not restart a deliberately stopped app.
  if (fs.existsSync(path.join(ROOT, 'disabled'))) return;
  if (process.argv.includes('--watchdog')) { watchdog(); return; }
  getNativeDiagnostics();
  if (process.argv.includes('--self-test') || process.argv.includes('--self-test-spawn')) {
    const code=sea.isSea()?sea.getAsset('self-test.cjs','utf8'):fs.readFileSync(path.join(__dirname,'self-test.cjs'),'utf8');
    await new Function('api','require',code)({createBridge,validateSessionAndACL,ROOT,PEER,VERSION,SETTINGS,HOME,FILE_ROOT,nativeDiagnostics},require);
    return;
  }
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const peer = validateTailnet();
  const session = validateSessionAndACL(ROOT);
  if(session.sid!==SETTINGS.owner_sid)throw new Error('Installation owner SID mismatch');
  const file = path.join(ROOT, 'token.txt');
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Token must be a regular file');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{96}$/.test(token)) throw new Error('Token must contain 48 random bytes as 96 hex characters');
  const bridge = createBridge({ token, session, recoverJobs:false });
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 25000, headersTimeout: 10000 }, bridge.handle);
  server.keepAliveTimeout = 1000;
  server.timeout = 28000;
  server.maxConnections = 32;
  server.on('clientError', (err, socket) => {
    bridge.audit({ event: 'malformed_http', source_ip: socket.remoteAddress, interface: null, error: err.code, exit_code: null });
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('error', e => { bridge.audit({ event: 'listener_error', error: e.code, exit_code: 1 }); process.exit(1); });
  server.listen({ host: HOST, port: PORT, exclusive: true }, () => {
    bridge.recoverInterruptedJobs();
    atomicJSON(path.join(ROOT, 'runtime.json'), { pid: process.pid, version: VERSION, started_at: new Date().toISOString(), session, listen: `${HOST}:${PORT}`, peer });
    bridge.audit({ event: 'service_start', version:VERSION,pid: process.pid, session_id: session.session_id, peer, listen: `${HOST}:${PORT}`, native_diagnostics:nativeDiagnostics,exit_code: null });
  });
  const monitor = createTailnetMonitor({ audit: bridge.audit, onLost: () => { server.close(); process.exit(1); } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    monitor.stop(); server.close(); await bridge.stop(); process.exit(0);
  });
}

if (sea.isSea() || require.main === module) {
  main().catch(e => {
    try { operationalError('startup_failed', e); } catch {}
    process.exit(1);
  });
} else module.exports = { createBridge, createTailnetMonitor, validateTailnet, validateSessionAndACL, validateConfiguration,configure,loadConfiguration,dataDirectory,tailnetIPv4,VERSION,HOME,hash };
