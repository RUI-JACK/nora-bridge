'use strict';
// Local CLI test only: no network listener or authentication exception is added.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Readable,Writable}=require('node:stream');
return (async()=>{
 const {createBridge,validateSessionAndACL,ROOT,PEER,VERSION,SETTINGS,HOME}=api;
 const session=validateSessionAndACL(ROOT),started=Date.now();
 const root=path.join(ROOT,'evidence','self-test-'+Date.now());fs.mkdirSync(root,{recursive:true});
 const token=fs.readFileSync(path.join(ROOT,'token.txt'),'utf8').trim();
 const bridge=createBridge({root,token,session,recoverJobs:false});
 const report={version:VERSION,mode:'LOCAL_GUI_SEA_HANDLER_SIMULATED_AGENT_REAL_CHILDREN',pid:process.pid,session,started_at:new Date().toISOString(),root,tests:[]};
 const file=path.join(ROOT,'evidence','self-test.json');
 const record=(name,output)=>{report.tests.push({name,passed:true,output});fs.writeFileSync(file,JSON.stringify(report,null,2));};
 async function call(method,url,body,source=PEER,auth=token){
   const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=url;req.socket={remoteAddress:source};req.headers={'content-type':'application/json',authorization:'Bearer '+auth};
   const chunks=[];const res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.writeHead=(code,headers)=>{res.statusCode=code;res.headers=headers;};
   await bridge.handle(req,res);if(!res.writableFinished)await new Promise(r=>res.once('finish',r));const raw=Buffer.concat(chunks);
   return {code:res.statusCode,raw,data:res.headers['Content-Type'].startsWith('application/json')?JSON.parse(raw):undefined};
 }
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function run(endpoint,body){
   const first=await call('POST',endpoint,body);assert([200,202].includes(first.code),JSON.stringify(first.data));let job=first.data;
   const out=[Buffer.from(job.stdout_base64,'base64')],err=[Buffer.from(job.stderr_base64,'base64')];let polls=0;
   while(job.state==='running'||job.has_more){await sleep(500);job=(await call('GET',`/exec/${job.job_id}?stdout_offset=${job.next_stdout_offset}&stderr_offset=${job.next_stderr_offset}`)).data;out.push(Buffer.from(job.stdout_base64,'base64'));err.push(Buffer.from(job.stderr_base64,'base64'));polls++;}
   return {http:first.code,state:job.state,job_id:job.job_id,exit_code:job.exit_code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),polls};
 }
 let scratch;
 try{
   const health=await call('GET','/health');assert.equal(health.code,200);assert.equal(health.data.version,VERSION);assert.equal(health.data.allowed_peer.ip,SETTINGS.allowed_peer.ip);record('health',health.data);
   assert.equal((await call('GET','/health',undefined,SETTINGS.listen_ip)).code,403);assert.equal((await call('GET','/health',undefined,PEER,'wrong')).code,401);record('authentication','self source 403; wrong token 401');
   const echo=await run('/exec',{command:"[Console]::Out.WriteLine('mvp-中文-ok'); [Console]::Error.WriteLine('stderr-ok'); exit 7",timeout_sec:30});assert.equal(echo.exit_code,7);assert.match(echo.stdout,/mvp-中文-ok/);assert.match(echo.stderr,/stderr-ok/);record('exec_utf8_exit_code',echo);
   const time=Date.now();const long=await run('/exec',{command:"Write-Output 'before'; Start-Sleep -Seconds 35; Write-Output 'after-35'",timeout_sec:60});assert.equal(long.http,202);assert.equal(long.exit_code,0);assert.equal(long.stdout,'before\r\nafter-35\r\n');record('exec_background',{...long,elapsed_seconds:(Date.now()-time)/1000});
   const timeout=await run('/exec',{command:"Start-Sleep -Seconds 20; Write-Output 'must-not-run'",timeout_sec:2});assert.equal(timeout.state,'timed_out');assert(!timeout.stdout.includes('must-not-run'));record('timeout_cleanup',timeout);
   const after=await run('/exec',{command:"Write-Output 'after-timeout'",timeout_sec:30});assert.equal(after.exit_code,0);assert.equal(after.stdout.trim(),'after-timeout');record('exec_after_timeout',after);
   scratch=path.join(HOME,'nora-mvp-file-'+Date.now()+'.txt');const bytes=Buffer.from('Nora MVP 往返\n','utf8');
   const upload=await call('POST','/file',{path:scratch,content_base64:bytes.toString('base64')});assert.equal(upload.code,200);const download=await call('GET','/file?path='+encodeURIComponent(scratch));assert.deepEqual(download.raw,bytes);record('file_roundtrip',upload.data);
   assert.equal((await call('GET','/file?path='+encodeURIComponent(path.join(ROOT,'token.txt')))).code,403);assert.equal((await call('GET','/file?path='+encodeURIComponent(path.join(process.env.SystemRoot,'win.ini')))).code,403);record('file_boundary','installation token and outside-profile path rejected');
   if(SETTINGS.ego_path){
     const ego=await run('/ego',{script:"console.log('nora-mvp-ego-ok');",timeout_sec:30});assert.equal(ego.exit_code,0);assert.match(ego.stdout+ego.stderr,/nora-mvp-ego-ok/);record('ego_cli',ego);
     const expired=await run('/ego',{script:"console.log('ego-timeout-start'); await new Promise(r=>setTimeout(r,20000)); console.log('must-not-run');",timeout_sec:2});assert.equal(expired.state,'timed_out');assert(!expired.stdout.includes('must-not-run')&&!expired.stderr.includes('must-not-run'));record('ego_timeout',expired);
     const afterEgo=await run('/exec',{command:"Write-Output 'after-ego-timeout'",timeout_sec:30});assert.equal(afterEgo.exit_code,0);assert.equal(afterEgo.stdout.trim(),'after-ego-timeout');record('exec_after_ego_timeout',afterEgo);
   }
   else{const ego=await call('POST','/ego',{script:"console.log('disabled')"});assert.equal(ego.code,503);record('ego_optional_disabled','503 without affecting exec/file');}
   const last=await call('GET','/health');assert.equal(last.data.pid,report.pid);assert.equal(last.data.active_jobs,0);record('same_parent_alive',last.data);
   report.passed=true;report.completed_at=new Date().toISOString();report.elapsed_seconds=(Date.now()-started)/1000;fs.writeFileSync(file,JSON.stringify(report,null,2));
 }catch(e){report.failure={message:e.message,stack:e.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw e;}
 finally{if(scratch&&fs.existsSync(scratch))fs.unlinkSync(scratch);await bridge.stop();}
})();
