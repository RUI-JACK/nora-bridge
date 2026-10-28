'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {Readable,Writable}=require('node:stream');const {EventEmitter}=require('node:events');
const core=require('../src/main.cjs');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'NoraMvpUnit-'));
const data=path.join(fixture,'data'),files=path.join(fixture,'files');fs.mkdirSync(data);fs.mkdirSync(files);
const sid='S-1-5-21-100-200-300-1001',instance='0123456789abcdef0123456789abcdef';
function config(root=data,home=core.HOME){return {schema_version:1,instance_id:instance,install_dir:root,owner_profile:home,owner_sid:sid,listen_ip:'100.64.0.10',listen_port:18743,self_node_id:'self-node',tailscale_interface:'Tailscale test',tailscale_path:'C:\\Program Files\\Tailscale\\tailscale.exe',allowed_peer:{id:'agent-node',name:'agent-device',ip:'100.64.0.20'},ego_path:null,file_root:home,task_name:'NoraBridge-MVP-'+instance,watchdog_task_name:'NoraBridge-MVP-'+instance+'-Watchdog'};}
function setup(){const c=config();c.file_root=files;core.configure(c,data);return c;}
async function call(bridge,method,url,body,source='100.64.0.20',token='unit-not-a-secret'){
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=url;req.socket={remoteAddress:source};req.headers={'content-type':'application/json',authorization:'Bearer '+token};
 const chunks=[];const res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.writeHead=(code,headers)=>{res.statusCode=code;res.headers=headers;};await bridge.handle(req,res);if(!res.writableFinished)await new Promise(r=>res.once('finish',r));const raw=Buffer.concat(chunks);
 return {code:res.statusCode,raw,data:res.headers['Content-Type'].startsWith('application/json')?JSON.parse(raw):undefined};
}
test('Tailscale address validation accepts only canonical 100.64/10 IPv4',()=>{
 for(const ip of ['100.64.0.1','100.127.255.254'])assert(core.tailnetIPv4(ip));
 for(const ip of ['0.0.0.0','127.0.0.1','192.168.1.2','100.63.255.255','100.128.0.1','100.064.0.1','::1','100.64.0.999'])assert(!core.tailnetIPv4(ip),ip);
});
test('Data directory flags work in both Node source and SEA argv layouts',()=>{
 const expected=path.resolve('D:\\Profiles\\测试 User\\Nora Bridge');
 assert.equal(core.dataDirectory(['nora-bridge.exe','--data-dir',expected]),expected);
 assert.equal(core.dataDirectory(['node.exe','main.cjs','--data-dir',expected]),expected);
 assert.throws(()=>core.dataDirectory(['nora-bridge.exe','--data-dir','--watchdog']));
});
test('Configuration handles another username/drive and Unicode paths without machine constants',()=>{
 const home='D:\\Profiles\\测试 User';const root=home+'\\AppData\\Local\\Nora Bridge';const c=config(root,home);assert.equal(core.validateConfiguration(c,root,home).owner_profile,home);
 c.file_root=home+'\\Documents';assert.doesNotThrow(()=>core.validateConfiguration(c,root,home));
 c.file_root='D:\\Profiles\\Another';assert.throws(()=>core.validateConfiguration(c,root,home),/inside/);
});
test('Configuration rejects wildcard/LAN/self peers, wrong owner and task identity',()=>{
 for(const mutate of [c=>c.listen_ip='0.0.0.0',c=>c.allowed_peer.ip='192.168.1.1',c=>c.allowed_peer.ip=c.listen_ip,c=>c.owner_profile='C:\\Users\\SomeoneElse',c=>c.task_name='nora-bridge',c=>c.ego_path='relative.exe',c=>c.listen_port=80,c=>c.allowed_peer.id='',c=>c.install_dir='D:\\elsewhere']){const c=config();mutate(c);assert.throws(()=>core.validateConfiguration(c,data));}
});
test('Runtime pins node IDs, peer IP and selected interface; rename alone does not change identity',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','src','main.cjs'),'utf8');
 const c=config();let status={BackendState:'Running',Self:{ID:'self-node',TailscaleIPs:[c.listen_ip]},Peer:{p:{ID:'agent-node',HostName:'renamed-agent',TailscaleIPs:[c.allowed_peer.ip],Online:true}}};
 let interfaces={'Tailscale test':[{address:c.listen_ip,family:'IPv4'}]};
 const module={exports:{}};const mock=name=>name==='node:child_process'?{...require(name),execFileSync:()=>JSON.stringify(status)}:name==='node:os'?{...require(name),networkInterfaces:()=>interfaces}:require(name);
 vm.runInNewContext(source,{require:mock,module,process,Buffer,URL,setTimeout,setInterval,clearTimeout,clearInterval,__dirname:path.join(__dirname,'..','src')});module.exports.configure(c,data);
 assert.equal(module.exports.validateTailnet().ip,c.allowed_peer.ip);
 status.Peer.p.ID='different-node';assert.throws(module.exports.validateTailnet,/refusing/);status.Peer.p.ID='agent-node';status.Self.ID='different-self';assert.throws(module.exports.validateTailnet,/refusing/);status.Self.ID='self-node';interfaces={Ethernet:interfaces['Tailscale test']};assert.throws(module.exports.validateTailnet,/refusing/);
});
test('All routes reject wrong source/token, and absent Ego returns 503',async()=>{
 setup();const bridge=core.createBridge({root:data,token:'unit-not-a-secret',session:{},recoverJobs:false});
 for(const url of ['/health','/exec','/ego','/file','/exec/'+crypto.randomUUID()]){assert.equal((await call(bridge,'GET',url,undefined,'100.64.0.10')).code,403);assert.equal((await call(bridge,'GET',url,undefined,'100.64.0.20','wrong')).code,401);}
 assert.equal((await call(bridge,'POST','/ego',{script:"console.log('disabled')"})).code,503);assert.equal(bridge.active.size,0);const health=await call(bridge,'GET','/health');assert.equal(health.data.edition,'universal-mvp');assert.equal(health.data.capabilities.ego,false);
});
test('File upload/download, overwrite protection, boundaries and junction rejection',async()=>{
 setup();const bridge=core.createBridge({root:data,token:'unit-not-a-secret',session:{},recoverJobs:false});const file=path.join(files,'中文 file.txt'),bytes=Buffer.from('mvp-中文😀\n');
 assert.equal((await call(bridge,'POST','/file',{path:file,content_base64:bytes.toString('base64')})).code,200);assert.deepEqual((await call(bridge,'GET','/file?path='+encodeURIComponent(file))).raw,bytes);
 assert.equal((await call(bridge,'POST','/file',{path:file,content_base64:''})).code,409);
 for(const p of [path.join(data,'token.txt'),path.join(files,'x:stream'),path.join(files,'NUL'),path.join(fixture,'outside.txt')])assert.equal((await call(bridge,'GET','/file?path='+encodeURIComponent(p))).code,403,p);
 const link=path.join(files,'linked');fs.symlinkSync(data,link,'junction');assert.equal((await call(bridge,'GET','/file?path='+encodeURIComponent(path.join(link,'anything')))).code,403);
});
test('Synchronous spawn errors produce terminal jobs, then a valid spawn can complete',async()=>{
 setup();let count=0;const bridge=core.createBridge({root:data,token:'unit-not-a-secret',session:{process_start_ticks:'0'},recoverJobs:false,spawnProcess:(_exe,args,options)=>{
  assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');if(++count===1){const e=new Error('spawn EPERM');e.code='EPERM';e.errno=-4048;e.syscall='spawn';throw e;}
  const child=new EventEmitter();setImmediate(()=>{fs.writeFileSync(path.join(args[1],'stdout.bin'),'success\r\n');fs.writeFileSync(path.join(args[1],'status.json'),JSON.stringify({state:'completed',exit_code:0}));child.emit('close',0);});return child;
 }});
 const failed=await call(bridge,'POST','/exec',{command:'test'});assert.equal(failed.code,200);assert.equal(failed.data.state,'failed');assert.equal(failed.data.spawn_error.errno,-4048);assert.equal(bridge.active.size,0);
 const good=await call(bridge,'POST','/exec',{command:'test2'});assert.equal(good.data.exit_code,0);assert.equal(good.data.stdout,'success\r\n');assert.equal(bridge.active.size,0);
});
test('Recovery is deferred until listener ownership is established',()=>{
 setup();const id=crypto.randomUUID(),dir=path.join(data,'jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify({job_id:id}));
 const bridge=core.createBridge({root:data,token:'unit-not-a-secret',session:{},recoverJobs:false});assert(!fs.existsSync(path.join(dir,'status.json')));bridge.recoverInterruptedJobs();assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'status.json'))).state,'interrupted');
});
test('Monitor requires six failures over sixty seconds and resets after success',async()=>{
 let now=0,fail=true,lost=0;const events=[];
 const monitor=core.createTailnetMonitor({now:()=>now,setTimer:()=>0,clearTimer:()=>{},check:async()=>{if(fail)throw new Error('transient');},audit:e=>events.push(e),onLost:()=>lost++});
 now=10000;await monitor.tick();assert.equal(lost,0);fail=false;now=20000;await monitor.tick();assert.equal(events.at(-1).event,'tailscale_recovered');fail=true;
 for(let n=1;n<=5;n++){now=20000+n*10000;await monitor.tick();}assert.equal(lost,0);now=80000;await monitor.tick();assert.equal(lost,1);monitor.stop();
});
test.after(()=>{
 const full=path.resolve(fixture),parent=path.resolve(os.tmpdir());assert.equal(path.dirname(full).toLowerCase(),parent.toLowerCase());assert(path.basename(full).startsWith('NoraMvpUnit-'));fs.rmSync(full,{recursive:true,force:true});
});
