// Finite, explicit native qualification. Requires a disposable Linuxx64 VM with sudo.
// Inputs are real reviewed tarballs; no publication, model call, Docker or fleet action.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {bootstrapInstallScript,bootstrapStatusCommand,CrabboxWorkspaceBootstrap} from '../../worker/bootstrap.ts';
const exec=promisify(execFile),repo=process.cwd();
const oldController='0a7149380cad4d3a52576417d2b953ff8e4c00ab';
const oldArchive='cfed4163399c80ef0bb8a1447de8f911953764275a3f3f46766c90d22e318984';
const oldManifest='06b980bf311bfd5d6c47395ce486a99267b500dd1d68366be9d9ef9f8888695c';
const oldNode='9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578';
const newNode='1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce';
const nodeELF={old:'93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',new:'94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=async p=>sha(await fs.readFile(p));
const shq=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const cleanEnv={HOME:process.env.HOME,USER:process.env.USER,PATH:process.env.PATH,LANG:'C.UTF-8',CI:'true'};
let evidence=process.env.RUNNER_TEMP?path.join(process.env.RUNNER_TEMP,'crabhelm37-evidence'):'';
const records=[];
async function write(name,value){await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o644});}
async function run(label,file,args=[],{check=true,env={},timeout=15*60_000,cwd=repo}={}){
 const start=Date.now();let r;
 try{r={...(await exec(file,args,{cwd,env:{...cleanEnv,...env},timeout,maxBuffer:16*1024*1024})),code:0};}
 catch(error){r={code:typeof error.code==='number'?error.code:-1,stdout:String(error.stdout??''),stderr:String(error.stderr??error.message)};}
 await write(label+'.stdout',r.stdout);await write(label+'.stderr',r.stderr);
 records.push({label,code:r.code,elapsedMs:Date.now()-start,stdoutSHA256:sha(r.stdout),stderrSHA256:sha(r.stderr)});
 if(check)assert.equal(r.code,0,`${label} failed; see retained stderr`);return r;
}
async function markerIdentity(){const s=await fs.stat('/tmp/crabhelm-install-failed-stage');return {uid:s.uid,gid:s.gid,mode:s.mode&0o777,ino:s.ino,mtimeMs:s.mtimeMs,sha256:await hash('/tmp/crabhelm-install-failed-stage')};}
async function markerChild(){
 evidence=process.argv[3];await fs.mkdir(evidence,{recursive:true});
 assert.notEqual(await fs.readlink('/proc/self/ns/mnt'),await fs.readlink('/proc/1/ns/mnt'),'Marker fixture requires its own mount namespace');
 assert.ok((await fs.readFile('/proc/self/mountinfo','utf8')).split('\n').some(line=>line.split(' ')[4]==='/tmp'&&line.split(' - ')[1]?.split(' ')[0]==='tmpfs'),'Marker fixture requires a private tmpfs mounted at /tmp');
 await assert.rejects(fs.stat('/tmp/crabhelm-install-failed-stage'),{code:'ENOENT'});
 const root=await fs.mkdtemp('/var/tmp/crabhelm37-marker-');await fs.chmod(root,0o755);
 const home=path.join(root,'home');await fs.mkdir(home);await fs.chown(home,65534,65534);await fs.chmod(home,0o700);
 await fs.writeFile('/tmp/crabhelm-install-failed-stage','plugin\n',{mode:0o600,flag:'wx'});const before=await markerIdentity();
 assert.ok(path.isAbsolute(process.argv[4]??''));const base=await fs.readFile(process.argv[4],'utf8');
 assert.equal(sha(base),'dcc0f349a7045af7a309842dc71ea5aa099375a000d96e8c61abc81f9e03c296');
 const outputs={};
 for(const [name,source] of [['base',base],['candidate',await fs.readFile(path.join(repo,'deploy/crabbox-profile/guest-install.sh'),'utf8')]]){
  const bundle=path.join(root,name);await fs.mkdir(path.join(bundle,'artifacts'),{recursive:true,mode:0o755});
  const script=path.join(bundle,'guest-install.sh');await fs.writeFile(script,source,{mode:0o644});
  const manifest=Buffer.from('{"fixture":"real tar failure before package admission"}\n'),garbage=Buffer.from('explicit invalid xz archive fixture\n');
  await fs.writeFile(path.join(bundle,'manifest.json'),manifest,{mode:0o644});await fs.writeFile(path.join(bundle,'artifacts/node-linux-x64.tar.xz'),garbage,{mode:0o644});
  const mh=sha(manifest),nh=sha(garbage);
  const r=await run('marker-'+name,'/usr/sbin/runuser',['-u','nobody','--','/usr/bin/env','-i','HOME='+home,'PATH=/usr/bin:/bin','CRABHELM_BUNDLE_MANIFEST_SHA256='+mh,'CRABHELM_NODE_SHA256='+nh,'CRABHELM_RELEASE_ID='+mh+'.'+'b'.repeat(64)+'.'+nh,'/bin/bash',script],{check:false});outputs[name]=r;
  assert.notEqual(r.code,0);assert.deepEqual(await markerIdentity(),before);
  if(name==='base')assert.match(r.stderr,/crabhelm-install-failed-stage: Permission denied/);
  else {assert.match(r.stderr,/crabhelm guest install: stage=node line=\d+ status=\d+/);assert.doesNotMatch(r.stderr,/crabhelm-install-failed-stage: Permission denied/);const match=r.stderr.match(/stage=node line=\d+ status=(\d+)/);assert.equal(r.code,Number(match[1]));}
 }
 const status=path.join(root,'status.sh');await fs.writeFile(status,bootstrapStatusCommand('','CRABHELM_NATIVE_MARKER'),{mode:0o644});
 const shell=()=>run('marker-reader-'+records.length,'/usr/sbin/runuser',['-u','nobody','--','/usr/bin/env','-i','HOME='+home,'PATH=/usr/bin:/bin','/bin/bash','-e','-o','pipefail',status]);
 await fs.writeFile('/tmp/crabhelm-install.log',outputs.candidate.stderr,{mode:0o644});assert.equal((await shell()).stdout.trim(),'CRABHELM_NATIVE_MARKER_INSTALL_FAILED_NODE');
 await fs.writeFile('/tmp/crabhelm-install.log','crabhelm guest install: stage=plugin line=236 status=1\n');assert.equal((await shell()).stdout.trim(),'CRABHELM_NATIVE_MARKER_INSTALL_FAILED_PLUGIN_DUPLICATE');
 await fs.writeFile('/tmp/crabhelm-install.log','crabhelm guest install: stage=node line=4 status=2\ncrabhelm guest install: stage=verify line=8 status=1\n');assert.equal((await shell()).stdout.trim(),'CRABHELM_NATIVE_MARKER_INSTALL_FAILED_ARTIFACT');
 await fs.unlink('/tmp/crabhelm-install.log');assert.equal((await shell()).stdout.trim(),'CRABHELM_NATIVE_MARKER_PENDING');
 await fs.writeFile('/tmp/crabhelm-install.log','noise crabhelm guest install: stage=node line=4 status=2\ncrabhelm guest install: stage=node line=wrong status=2\n');assert.equal((await shell()).stdout.trim(),'CRABHELM_NATIVE_MARKER_INSTALL_FAILED_PACKAGE');
 await fs.writeFile('/tmp/crabhelm-install.log',outputs.candidate.stderr,{mode:0o644});
 let diagnosticsCommand='';const listeners=new Map();
 const socket={binaryType:'arraybuffer',addEventListener:(type,listener)=>listeners.set(type,listener),close:()=>{},send:(text)=>{if(diagnosticsCommand)return;diagnosticsCommand=text;const label=text.match(/CRABHELM_DIAGNOSTIC_[0-9a-f]+/)[0];queueMicrotask(()=>listeners.get('message')({data:label+'_BEGIN\n'+label+'_END\n'}));}};
 const owner=new CrabboxWorkspaceBootstrap({brokerToken:'synthetic',publicUrl:'https://fixture.invalid',releaseId:'a'.repeat(64),archiveId:'b'.repeat(64),nodeId:'c'.repeat(64),signingSecret:'d'.repeat(64),terminalDialer:async()=>socket});
 await owner.runtimeDiagnostics({}, {status:'ready',attachUrl:'wss://fixture.invalid/attach'});
 const diagnostic=path.join(root,'diagnostics.sh');await fs.writeFile(diagnostic,diagnosticsCommand,{mode:0o644});
 const dr=await run('marker-real-generated-diagnostics','/usr/sbin/runuser',['-u','nobody','--','/usr/bin/env','-i','HOME='+home,'PATH=/usr/bin:/bin','/bin/bash','-e','-o','pipefail',diagnostic]);
 assert.match(dr.stdout,/INSTALL_STAGE node/);assert.match(dr.stdout,/STATE .*install_stage=node/);
 await write('marker-result.json',{pass:true,scope:'Real installer red/green and generated reader, root0600 legacy file untouched; private /tmp mount namespace; invalid archive is a focused gate fixture, not real package proof.',before,after:await markerIdentity(),records});
}
async function build(){
 const inputs=process.env.CRABHELM_QUALIFICATION_INPUTS;assert.ok(path.isAbsolute(inputs??''));
 const profile=await fs.readFile('deploy/crabbox-profile/profile.conf','utf8');const core=profile.match(/^openclaw_tarball_sha256=([0-9a-f]{64})$/m)?.[1];assert.ok(core);
 for(const [name,expected] of [['released-predecessor.tgz',oldArchive],['reviewed-openclaw.tgz',core],['slack-2026.7.1.tgz','d6ae8745867d812560e917707e633c8b66b36f7270124a8cca9602c6dc98ef46'],['diagnostics-otel-2026.7.1.tgz','a447a223cf4764865570e71e92fb5173bf79a3d8307dd99382eb56ea6aff93f6']])assert.equal(await hash(path.join(inputs,name)),expected,name);
 const out=path.join(process.env.RUNNER_TEMP,'crabhelm37-built');await fs.mkdir(out);
 const nodeArchive=path.join(out,'node-v22.23.4-linux-x64.tar.xz');await run('download-official-node','curl',['--fail','--silent','--show-error','--location','https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz','--output',nodeArchive]);assert.equal(await hash(nodeArchive),newNode);
 await run('build-real-appliance','/bin/bash',['deploy/crabbox-profile/build-bundle.sh','--node-tarball',nodeArchive,'--openclaw-tarball',path.join(inputs,'reviewed-openclaw.tgz'),'--slack-tarball',path.join(inputs,'slack-2026.7.1.tgz'),'--otel-tarball',path.join(inputs,'diagnostics-otel-2026.7.1.tgz'),'--output',path.join(out,'bundle')]);
 const manifest=JSON.parse(await fs.readFile(path.join(out,'bundle/manifest.json'),'utf8'));for(const value of Object.values(manifest))if(value&&typeof value==='object'&&value.file)assert.equal(await hash(path.join(out,'bundle',value.file)),value.sha256);
 await run('archive-real-appliance','tar',['-czf',path.join(out,'new-bundle.tgz'),'-C',out,'bundle']);await fs.copyFile(path.join(inputs,'released-predecessor.tgz'),path.join(out,'released-predecessor.tgz'));
 const receipt={head:process.env.CRABHELM_EXPECTED_HEAD,coreSHA256:core,archiveSHA256:await hash(path.join(out,'new-bundle.tgz')),manifestSHA256:await hash(path.join(out,'bundle/manifest.json')),manifest,predecessorArchiveSHA256:oldArchive,scope:'Built ONCE by canonical builder with unchanged reviewed profile pin/gates; artifact bytes reused by fresh/upgrade jobs.'};
 await fs.writeFile(path.join(out,'build-receipt.json'),JSON.stringify(receipt,null,2)+'\n');await write('build-receipt.json',receipt);
 if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,'bundle-sha256='+receipt.archiveSHA256+'\n');
}
const childId='11111111-1111-4111-8111-111111111111';const auth='synthetic-bootstrap-only-qualification';
let server,CAInstalled=false,installed=false;const states=[];let tlsProviderRequests=0;
async function cli(version,args,label,{env={}}={}){
 const bin='/var/lib/crabhelm-agent/.local/share/crabhelm/openclaw-'+version+'/bin/openclaw';
 const unit=(await run(label+'-unit-path','sudo',['-n','systemctl','show','--property=Environment','--value','crabhelm-agent.service'])).stdout;
 const runtime=unit.match(/PATH=([^\s]+)/)?.[1];assert.ok(runtime);
 return run(label,'sudo',['-n','-u','crabhelm-agent','/usr/bin/env','-i','HOME=/var/lib/crabhelm-agent','USER=crabhelm-agent','OPENCLAW_STATE_DIR=/var/lib/crabhelm-agent/.openclaw','PATH='+runtime,...Object.entries(env).map(([k,v])=>k+'='+v),bin,...args]);
}
async function gateway(version,method,params,label){const r=await cli(version,['gateway','call',method,'--params',JSON.stringify(params),'--json'],label);return JSON.parse(r.stdout);}
const sessionKey='agent:main:crabhelm-upgrade-proof',sessionText='Crabhelm retained genuine session '+randomUUID(),memoryText='# Native qualification retained memory\n'+randomUUID()+'\n';
async function seed(version){
 await cli(version,['config','set','session.dmScope','per-channel-peer'],'seed-real-config');
 await run('seed-config-restart','sudo',['-n','systemctl','restart','crabhelm-agent.service']);await waitReady();
 await gateway(version,'sessions.reset',{key:sessionKey},'seed-real-session');
 await gateway(version,'chat.inject',{sessionKey,message:sessionText,label:'Qualification'},'seed-real-transcript');
 await gateway(version,'agents.files.set',{agentId:'main',name:'MEMORY.md',content:memoryText},'seed-real-workspace');
}
async function checkState(version,label){
 const cfg=(await cli(version,['config','get','session.dmScope'],label+'-config')).stdout.trim();assert.ok(cfg==='per-channel-peer'||cfg==='"per-channel-peer"');
 const history=await gateway(version,'chat.history',{sessionKey},label+'-history');assert.ok(JSON.stringify(history).includes(sessionText),'Saved transcript not readable through actual Gateway');
 const memory=await gateway(version,'agents.files.get',{agentId:'main',name:'MEMORY.md'},label+'-memory');assert.equal(memory.file.content,memoryText);
 await write(label+'-state.json',{version,config:cfg,history,memory});
}
async function waitReady(){for(let i=0;i<60;i++){try{await exec('curl',['--fail','--silent','--max-time','2','http://127.0.0.1:18789/readyz']);return;}catch{if(i===59)throw Error('Target readiness did not recover after restart');await new Promise(r=>setTimeout(r,1000));}}}
async function service(label,expectedNode,version){
 const pid=Number((await run(label+'-mainpid','sudo',['-n','systemctl','show','--property=MainPID','--value','crabhelm-agent.service'])).stdout.trim());assert.ok(pid>1);
 const executable=(await run(label+'-executable','sudo',['-n','readlink','/proc/'+pid+'/exe'])).stdout.trim();const actual=(await run(label+'-elf','sudo',['-n','sha256sum',executable])).stdout.split(/\s/)[0];assert.equal(actual,nodeELF[expectedNode]);
 const uid=Number((await run(label+'-uid','sudo',['-n','stat','-c','%u','/proc/'+pid])).stdout.trim());const expectedUID=Number((await run(label+'-account-uid','id',['-u','crabhelm-agent'])).stdout.trim());assert.ok(expectedUID>0);assert.equal(uid,expectedUID);
 const noSudo=(await run(label+'-no-sudo','sudo',['-n','-u','crabhelm-agent','sudo','-n','true'],{check:false})).code!==0;assert.ok(noSudo);
 const unit=(await run(label+'-unit','sudo',['-n','systemctl','cat','crabhelm-agent.service'])).stdout;assert.ok(unit.includes(path.dirname(executable)));
 const expectedCLI='/var/lib/crabhelm-agent/.local/share/crabhelm/openclaw-'+version+'/bin/openclaw';assert.ok(unit.includes('ExecStart='+expectedCLI+' gateway --port 18789'));
 const liveCmdline=(await run(label+'-live-cmdline','sudo',['-n','cat','/proc/'+pid+'/cmdline'])).stdout.replaceAll('\0',' ');assert.ok(liveCmdline.includes(expectedCLI)||/^openclaw(?:-gateway)?\s*$/.test(liveCmdline),'Unexpected live Gateway executable title/argv');
 const ready=(await run(label+'-ready','curl',['--fail','--silent','--show-error','--max-time','5','http://127.0.0.1:18789/readyz'])).stdout;
 const output=(await cli(version,['--version'],label+'-version')).stdout;assert.ok(output.includes(version));
 const presence=await gateway(version,'system-presence',{},label+'-live-server-presence');assert.ok(Array.isArray(presence));const self=presence.find(x=>x.mode==='gateway'&&x.reason==='self');assert.ok(self,'Missing real Gateway self-presence');assert.equal(self.version,version,'Live service is running the wrong OpenClaw version');
 const row={label,pid,uid,expectedUID,executable,executableSHA256:actual,ready,versionOutput:output,noSudo,selectedUnit:unit,liveCmdline,expectedCLI,liveGatewaySelf:self};states.push(row);await write(label+'-identity.json',row);
}
async function lifecycle(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,'openclaw/crabhelm');assert.equal(process.env.GITHUB_EVENT_NAME,'pull_request');assert.equal(process.env.RUNNER_ARCH,'X64');
 const event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8'));assert.equal(event.pull_request.number,37);assert.equal(event.pull_request.head.repo.full_name,'openclaw/crabhelm');assert.equal(event.pull_request.head.sha,process.env.CRABHELM_EXPECTED_HEAD);
 assert.notEqual((await run('admit-no-managed-account','getent',['passwd','crabhelm-agent'],{check:false})).code,0,'Existing managed account must never be reused by this disposable qualification');
 for(const file of ['/etc/systemd/system/crabhelm-agent.service','/etc/systemd/system/crabhelm-egress.service','/var/lib/crabhelm-agent','/usr/local/share/ca-certificates/crabhelm37-native-qualification.crt'])assert.equal((await run('admit-absent-'+path.basename(file),'sudo',['-n','test','-e',file],{check:false})).code,1,'Preexisting task path: '+file);
 const scenario=process.env.CRABHELM_QUALIFICATION_SCENARIO;assert.ok(['fresh','upgrade'].includes(scenario));
 const built=process.env.CRABHELM_QUALIFICATION_BUILT;assert.ok(path.isAbsolute(built??''));const receipt=JSON.parse(await fs.readFile(path.join(built,'build-receipt.json'),'utf8'));
 assert.equal(receipt.head,process.env.CRABHELM_EXPECTED_HEAD);assert.equal(await hash(path.join(built,'new-bundle.tgz')),process.env.CRABHELM_EXPECTED_BUNDLE_SHA256);assert.equal(receipt.archiveSHA256,process.env.CRABHELM_EXPECTED_BUNDLE_SHA256);assert.equal(await hash(path.join(built,'released-predecessor.tgz')),oldArchive);
 const profile=await fs.readFile('deploy/crabbox-profile/profile.conf','utf8');assert.ok(profile.includes('openclaw_tarball_sha256='+receipt.coreSHA256));
 await run('native-packages','sudo',['-n','apt-get','update']);await run('native-nftables','sudo',['-n','apt-get','install','-y','nftables']);
 if(scenario==='fresh'){
  const baseline=(await run('marker-original-source','git',['show','b508e5cd8c1321249ed282ca2bfaad0b65a5381b:deploy/crabbox-profile/guest-install.sh'])).stdout;const baselineFile=path.join(evidence,'marker-original.sh');await fs.writeFile(baselineFile,baseline,{mode:0o644});
  const ns=path.join(evidence,'marker-ns.sh');await fs.writeFile(ns,'#!/bin/bash\nset -euo pipefail\nmount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp\nexec '+shq(process.execPath)+' --import '+shq(path.join(repo,'node_modules/tsx/dist/loader.mjs'))+' '+shq(process.argv[1])+' --marker-child '+shq(path.join(evidence,'marker'))+' '+shq(baselineFile)+'\n');
  await run('native-marker-red-green','sudo',['-n','/usr/bin/unshare','--mount','--propagation','private','--fork','/bin/bash',ns]);assert.equal(JSON.parse(await fs.readFile(path.join(evidence,'marker/marker-result.json'),'utf8')).pass,true);
 }
 const privateRoot=path.join(process.env.RUNNER_TEMP,'crabhelm37-private-state');await fs.mkdir(privateRoot,{mode:0o700});
 const cert=path.join(privateRoot,'fixture-ca.pem'),key=path.join(privateRoot,'fixture-ca.key');await run('make-local-https-fixture','openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=crabhelm37-native-qualification','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
 await run('install-task-ca','sudo',['-n','install','-m','0644',cert,'/usr/local/share/ca-certificates/crabhelm37-native-qualification.crt']);CAInstalled=true;await run('activate-task-ca','sudo',['-n','update-ca-certificates']);
 const spec={schemaVersion:1,readOnly:true,clawId:childId,persona:{id:'native-proof',name:'Native proof'},capabilityIds:[],skills:[],instructions:{identity:'# Native proof\n',soul:'# Native proof\n',agents:'# Native proof\n'},observability:{logLevel:'info',otel:{enabled:false}}};
 server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},async(req,res)=>{
  try{
   if(req.url.startsWith('/v1/')){tlsProviderRequests++;req.resume();res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic invalid fixture key',type:'invalid_request_error',code:'invalid_api_key'}}));return;}
   if(req.method!=='GET'){req.resume();res.writeHead(503);res.end('{"fixture":"control broker intentionally unavailable; no connected-runtime claim"}');return;}
   if(req.headers.authorization!=='Bearer '+auth){res.writeHead(403);res.end();return;}
   const url=new URL(req.url,'https://127.0.0.1:19400'),tag=url.pathname.split('/')[2];assert.ok(['old','new'].includes(tag));
   if(url.pathname.endsWith('/bundle.tgz')){const file=path.join(built,tag==='old'?'released-predecessor.tgz':'new-bundle.tgz');res.setHeader('content-length',(await fs.stat(file)).size);createReadStream(file).pipe(res);return;}
   if(url.pathname.endsWith('/managed-spec.json')){res.end(JSON.stringify(spec));return;}
   if(url.pathname.endsWith('/credentials.env')){const expectedGeneration=tag==='old'?1:scenario==='upgrade'?2:1;res.setHeader('content-type','text/plain; charset=utf-8');if(url.searchParams.get('credentials')!==String(expectedGeneration)){res.writeHead(400);res.end('Invalid fixture generation\n');return;}res.end('OPENAI_API_KEY=synthetic-invalid-qualification-only\nCRABHELM_CONTROL_URL=https://127.0.0.1:19400\nCRABHELM_RUNTIME_TOKEN=synthetic-runtime-token-generation-'+expectedGeneration+'\nCRABHELM_CHILD_ID='+childId+'\n');return;}
   res.writeHead(404);res.end();
  }catch(error){res.writeHead(500);res.end('fixture setup error');}
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(19400,'127.0.0.1',resolve);});
 const invalidQuery=new URL('https://127.0.0.1:19400/bootstrap/new/credentials.env');invalidQuery.searchParams.set('credentials','fixture-reflection-negative\nINJECTED=value');
 const invalidHeaders=path.join(privateRoot,'invalid-query.headers');const invalidResponse=await run('fixture-invalid-generation-query','curl',['--silent','--show-error','--max-time','5','--cacert',cert,'--header','Authorization: Bearer '+auth,'--dump-header',invalidHeaders,'--write-out','\nHTTP_STATUS:%{http_code}\n',invalidQuery.href]);assert.equal(invalidResponse.stdout,'Invalid fixture generation\n\nHTTP_STATUS:400\n');assert.doesNotMatch(invalidResponse.stdout,/fixture-reflection-negative|INJECTED/);assert.match(await fs.readFile(invalidHeaders,'utf8'),/content-type: text\/plain/i);
 const options=(tag,generation)=>({base:'https://127.0.0.1:19400/bootstrap/'+tag,releaseId:tag==='old'?oldManifest:receipt.manifestSHA256,archiveId:tag==='old'?oldArchive:receipt.archiveSHA256,nodeSha256:tag==='old'?oldNode:newNode,childId,model:'openai/gpt-4o-mini',slack:'false',policyHash:'a'.repeat(64),credentialsGeneration:generation,egressLockdown:'required'});
 async function install(tag,owner,generation){const script=path.join(privateRoot,tag+'-install.sh');await fs.writeFile(script,owner(options(tag,generation)),{mode:0o600});await write(tag+'-install-identity.json',{scriptSHA256:await hash(script),options:options(tag,generation)});installed=true;await run(tag+'-genuine-install','timeout',['--signal=TERM','--kill-after=10s','10m','/bin/bash',script],{env:{CRABHELM_BOOTSTRAP_TOKEN:auth},timeout:11*60_000});}
 if(scenario==='upgrade'){
  const oldSource=path.join(privateRoot,'old-controller');await fs.mkdir(oldSource);const archive=path.join(privateRoot,'old-controller.tar');await run('old-controller-archive','git',['archive','--format=tar','--output='+archive,oldController]);await run('old-controller-extract','tar',['-xf',archive,'-C',oldSource]);
  assert.equal(await hash(path.join(oldSource,'worker/bootstrap.ts')),'c83f4a7367d5a5f6c0171f9f1436d60a71d2bf3450acafb55bfbce4bc9926d21');
  const old=await import(pathToFileURL(path.join(oldSource,'worker/bootstrap.ts')).href);await install('old',old.bootstrapInstallScript,1);await service('released-predecessor','old','2026.6.11');await seed('2026.6.11');await checkState('2026.6.11','before-upgrade');
 }else{
  // An explicit foreign residue fixture, not a claim of an installed predecessor.
  await assert.rejects(fs.stat('/tmp/crabhelm-install-failed-stage'),{code:'ENOENT'});
  await fs.writeFile('/tmp/crabhelm-install-failed-stage','plugin\n',{mode:0o600,flag:'wx'});
 }
 const legacyBefore=(await run('legacy-stage-before','sudo',['-n','stat','-c','%u:%g:%a:%i:%Y','/tmp/crabhelm-install-failed-stage'])).stdout;
 const legacyHashBefore=(await run('legacy-stage-hash-before','sudo',['-n','sha256sum','/tmp/crabhelm-install-failed-stage'])).stdout;
 await install('new',bootstrapInstallScript,scenario==='upgrade'?2:1);await service('target-initial','new','2026.7.1');
 assert.equal((await run('legacy-stage-after','sudo',['-n','stat','-c','%u:%g:%a:%i:%Y','/tmp/crabhelm-install-failed-stage'])).stdout,legacyBefore);assert.equal((await run('legacy-stage-hash-after','sudo',['-n','sha256sum','/tmp/crabhelm-install-failed-stage'])).stdout,legacyHashBefore);
 if(scenario==='fresh')await seed('2026.7.1');await checkState('2026.7.1','after-target-install');
 await run('target-second-restart','sudo',['-n','systemctl','restart','crabhelm-agent.service']);
 await waitReady();
 await service('target-after-restart','new','2026.7.1');await checkState('2026.7.1','after-second-restart');await write('genuine-artifact-receipt.json',receipt);
 if(scenario==='fresh')await productTLS(cert,privateRoot);
 await write('scope.json',{scenario,oldController:scenario==='upgrade'?oldController:null,predecessor:'Real recovered2026.6.11, not unavailable immediatePR16 predecessor',state:'Real Gateway session/transcript and workspace writer/readers plus existing config; same managed account. No operatorHOME migration or live model/broker/provider canary claimed.',TLS:scenario==='fresh'?'Actual installed models status provider probes; see product-tls-results.json for exact scenarios, native errors and authenticated TLS controls. Synthetic keys; no real provider/model correctness claim.':'TLS exercised on identical built archive in fresh sibling job; this upgrade job establishes state/runtime lifecycle only.'});
}
async function productTLS(privateCA,privateRoot){
 // Read-only diagnostics observers record the real installed fetch transport's native error.
 // No custom dispatcher, fetch/crypto replacement, verification override or model stub in the product.
 const observer=path.join(privateRoot,'tls-observer.mjs');
 await fs.writeFile(observer,`import dc from 'node:diagnostics_channel';import fs from 'node:fs';
 const out=process.env.CRABHELM_TLS_OBSERVER;const write=x=>fs.appendFileSync(out,JSON.stringify(x)+'\\n');
 dc.channel('undici:request:error').subscribe(x=>{const codes=[];let e=x.error;for(let i=0;e&&i<8;i++,e=e.cause)if(typeof e.code==='string')codes.push(e.code);write({event:'native-error',origin:String(x.request.origin),codes});});
 dc.channel('undici:client:connected').subscribe(x=>write({event:'connected',host:x.connectParams.hostname??x.connectParams.host,port:x.connectParams.port,authorized:x.socket.authorized===true,protocol:x.socket.getProtocol?.()}));
 `,{mode:0o644});
 // Agent can read only public fixture material; CA key stays in the runner's private directory.
 const agentDir='/var/lib/crabhelm-agent/crabhelm37-tls-proof';await run('tls-agent-proof-dir','sudo',['-n','install','-d','-o','crabhelm-agent','-g','crabhelm-agent','-m','0700',agentDir]);
 await run('tls-agent-observer','sudo',['-n','install','-o','crabhelm-agent','-g','crabhelm-agent','-m','0600',observer,agentDir+'/observer.mjs']);
 await run('tls-agent-public-ca','sudo',['-n','install','-o','crabhelm-agent','-g','crabhelm-agent','-m','0600',privateCA,agentDir+'/private-ca.pem']);
 const archive=path.join(privateRoot,'incident-chains.zip');await run('download-pinned-public-incident-chains','curl',['--fail','--silent','--show-error','--location','https://emudhra.we-have-a-problem.com/chains.zip','--output',archive]);assert.equal(await hash(archive),'7b949956955fc501a30f4d98d2f513d34c0bbbe92e29a968194c96e097ce2345');
 const hosts=['dv-g3b','dv-g3c','ov-g3b','ov-g3c','ev-g3b','ev-g3c','dv-g3b-aaa','dv-g3c-aaa','ov-g3b-aaa','ov-g3c-aaa','ev-g3b-aaa','ev-g3c-aaa','dv-g3b-noct','dv-g3b-aaa-noct'].map(x=>x+'-emudhra.we-have-a-problem.com');
 const rows=[];let currentProviderURL=null;
 await cli('2026.7.1',['config','set','agents.defaults.models',JSON.stringify({'emudhra-proof/qualification-model':{}})],'tls-allow-model');
 async function probe(label,url,mode,ca,expected){
  const provider={baseUrl:url,apiKey:'synthetic-invalid-qualification-only',api:'openai-completions',models:[{id:'qualification-model',name:'TLS transport qualification',reasoning:false,input:['text'],contextWindow:8192,maxTokens:64,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
  if(currentProviderURL!==url){await cli('2026.7.1',['config','set','models.providers.emudhra-proof',JSON.stringify(provider)],label+'-config');currentProviderURL=url;}
  const logfile=agentDir+'/'+label+'.jsonl';await run(label+'-observer-file','sudo',['-n','-u','crabhelm-agent','touch',logfile]);
  const flags=['--import='+agentDir+'/observer.mjs'];if(mode==='system')flags.push('--use-system-ca');if(mode==='openssl')flags.push('--use-openssl-ca');
  const env={NODE_OPTIONS:flags.join(' '),CRABHELM_TLS_OBSERVER:logfile};if(ca)env.NODE_EXTRA_CA_CERTS=ca;
  const before=tlsProviderRequests;const result=await cli('2026.7.1',['models','status','--json','--probe','--probe-provider','emudhra-proof','--probe-timeout','12000','--probe-concurrency','1','--probe-max-tokens','1'],label,{env});
  const raw=(await run(label+'-observer-read','sudo',['-n','cat',logfile])).stdout;
  const events=raw.trim()?raw.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
  await write(label+'-native-transport.json',events);
  const targetURL=new URL(url),target=targetURL.hostname;
  const errors=events.filter(x=>{if(x.event!=='native-error')return false;try{return new URL(x.origin).origin===targetURL.origin;}catch{return false;}});
  const connections=events.filter(x=>x.event==='connected'&&x.host===target&&Number(x.port??443)===Number(targetURL.port||443));
  const codes=errors.flatMap(x=>x.codes??[]),authorized=connections.filter(x=>x.authorized);
  rows.push({label,url,mode,explicitCA:ca??null,expected,actualTargetNativeCodes:codes,authorizedTargetConnections:authorized,productCLIExit:result.code,localProviderRequests:tlsProviderRequests-before});
  await write('product-tls-results.json',{pass:false,complete:false,plannedIncidentRows:56,rows});
  if(expected==='revoked'){assert.ok(codes.includes('CERT_REVOKED'),label+' did not show target-native CERT_REVOKED; generic fetch/DNS/timeout is insufficient');assert.equal(authorized.length,0,'Incident target obtained an authorized TLS connection');}
  else if(expected==='untrusted'){assert.ok(codes.some(x=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(x)),'Private negative did not expose a native issuer error');assert.equal(authorized.length,0);assert.equal(tlsProviderRequests,before,'Untrusted private endpoint received HTTP');}
  else {assert.ok(authorized.length>0,label+' did not establish target-authorized TLS');assert.ok(!codes.includes('CERT_REVOKED'));if(target==='127.0.0.1')assert.ok(tlsProviderRequests>before,'Private TLS endpoint did not receive actual product request');}

 }
 // Public/private positive controls exercise the same actual CLI/provider transport with invalid keys.
 await probe('tls-private-builtin-untrusted','https://127.0.0.1:19400/v1','builtin',null,'untrusted');
 for(const mode of ['builtin','extra','system','openssl'])await probe('tls-public-'+mode,'https://api.openai.com/v1',mode,mode==='extra'?agentDir+'/private-ca.pem':null,'authorized');
 for(const mode of ['extra','system','openssl'])await probe('tls-private-'+mode,'https://127.0.0.1:19400/v1',mode,mode==='extra'?agentDir+'/private-ca.pem':null,'authorized');
 for(const [index,host]of hosts.entries()){
  const pem=path.join(privateRoot,host+'.pem');const content=(await run('tls-chain-extract-'+index,'unzip',['-p',archive,'chains/'+host+'.pem'])).stdout;await fs.writeFile(pem,content,{mode:0o600});
  const ca=agentDir+'/'+host+'.pem';await run('tls-chain-admit-'+index,'sudo',['-n','install','-o','crabhelm-agent','-g','crabhelm-agent','-m','0600',pem,ca]);
  for(const mode of ['builtin','extra','system','openssl'])await probe('tls-incident-'+index+'-'+mode,'https://'+host+'/v1',mode,mode==='extra'?ca:null,'revoked');
 }
 await write('product-tls-results.json',{pass:true,scope:'Actual installed OpenClaw models status --probe/embedded provider transport, actual patched selected Node, native diagnostic-channel error/authorized-socket observation. Public/private HTTP auth rejection with synthetic invalid key is only a TLS compatibility control, not a real model canary.',rows});
}
async function captureFailure(){
 await run('failure-unit-state','sudo',['-n','systemctl','show','crabhelm-agent.service','crabhelm-egress.service','--property=ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,ExecStart,User,FragmentPath'],{check:false});
 await run('failure-unit-definition','sudo',['-n','systemctl','cat','crabhelm-agent.service','crabhelm-egress.service'],{check:false});
 await run('failure-bounded-journal','sudo',['-n','journalctl','--no-pager','-n','120','-u','crabhelm-agent.service','-u','crabhelm-egress.service'],{check:false});
 await run('failure-disk','df',['-B1','/'],{check:false});await run('failure-memory','free',['-b'],{check:false});
 const pid=Number((await run('failure-mainpid','sudo',['-n','systemctl','show','--property=MainPID','--value','crabhelm-agent.service'],{check:false})).stdout.trim());
 if(Number.isInteger(pid)&&pid>1){
  await run('failure-live-executable','sudo',['-n','readlink','/proc/'+pid+'/exe'],{check:false});
  await run('failure-live-cmdline','sudo',['-n','cat','/proc/'+pid+'/cmdline'],{check:false});
  await run('failure-live-status','sudo',['-n','cat','/proc/'+pid+'/status'],{check:false});
 }
}
async function cleanup(){
 if(installed){await run('cleanup-stop-services','sudo',['-n','systemctl','disable','--now','crabhelm-agent.service','crabhelm-egress.service'],{check:false});
  const pid=(await run('cleanup-bridge-pid','sudo',['-n','cat','/var/lib/crabhelm-agent/.openclaw/crabhelm-runtime-bridge.pid'],{check:false})).stdout.trim();if(/^\d+$/.test(pid)){const cmd=(await run('cleanup-bridge-identity','sudo',['-n','cat','/proc/'+pid+'/cmdline'],{check:false})).stdout;if(cmd.includes('/runtime/runtime-bridge.mjs'))await run('cleanup-exact-bridge','sudo',['-n','kill','-TERM',pid],{check:false});}
  await run('cleanup-own-nft','sudo',['-n','nft','delete','table','inet','crabhelm_egress'],{check:false});}
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 if(CAInstalled){await run('cleanup-task-ca','sudo',['-n','rm','--','/usr/local/share/ca-certificates/crabhelm37-native-qualification.crt'],{check:false});await run('cleanup-refresh-ca','sudo',['-n','update-ca-certificates'],{check:false});}
}
let success=false,error;
try{
 assert.equal(os.platform(),'linux');assert.equal(os.arch(),'x64');assert.equal(process.version,'v22.23.4');
 if(process.argv[2]==='--marker-child'){await markerChild();success=true;}
 else{
  assert.ok(path.isAbsolute(process.env.RUNNER_TEMP??''));await fs.mkdir(evidence,{recursive:true});
  const head=(await exec('git',['rev-parse','HEAD'])).stdout.trim();assert.equal(head,process.env.CRABHELM_EXPECTED_HEAD);await write('admission.json',{head,processVersion:process.version,arch:os.arch(),CPU:os.cpus().length,memory:os.totalmem(),kernel:os.release(),scope:'Supported isolated hostedLinuxx64 lane; no UTM/ARM/native-hardware substitution'});
  if(process.argv[2]==='--build')await build();else await lifecycle();success=true;
 }
}catch(e){error=e.stack??String(e);process.exitCode=1;}
finally{
 if(process.argv[2]!=='--marker-child'){if(error&&installed){try{await captureFailure();}catch(diagnosticError){console.error('Failure diagnostic capture incomplete:',diagnosticError.message);}}await cleanup();}if(evidence)await write('result.json',{pass:success,error,head:process.env.CRABHELM_EXPECTED_HEAD,records,states});if(error)console.error(error);
}
