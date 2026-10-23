// Secretless native admission for the exact credentialed artifact-transport image.
// This is a runtime component proof; installed OpenClaw proof remains in the native lifecycle job.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
assert.equal(process.version,'v24.22.1');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
for(const key of ['GITHUB_TOKEN','GH_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_USE_SYSTEM_CA','NODE_TLS_REJECT_UNAUTHORIZED'])assert.ok(!process.env[key],'Admission must run with no credentials or trust overrides: '+key);
const fixtureInventory=[{"host":"dv-g3b-emudhra.we-have-a-problem.com","chainPEMSHA256":"ab6483de0cb01d53d59275baf74d2766f3599e57a48d3319e4a5536c268ac696"},{"host":"dv-g3c-emudhra.we-have-a-problem.com","chainPEMSHA256":"370e97ac882a900d25bda5b8ffe0136197e41d1ab424c3f04adad77825283803"},{"host":"ov-g3b-emudhra.we-have-a-problem.com","chainPEMSHA256":"c80265d7a38b7378544488d35c317598d5d8b9a1444468f68aa96b134d561d0b"},{"host":"ov-g3c-emudhra.we-have-a-problem.com","chainPEMSHA256":"45e16413868da62601227eb792c9d8a2172f0765fde3e7f21524e188bd3a1f41"},{"host":"ev-g3b-emudhra.we-have-a-problem.com","chainPEMSHA256":"000c2f6b03a9903488ee18e09c6b86e22c2476d0052e11888e5f924de6ad0d44"},{"host":"ev-g3c-emudhra.we-have-a-problem.com","chainPEMSHA256":"636f60b161812118b0474d5fdc1e194aaa1913ebc06331e0f24b324f08ba9a73"},{"host":"dv-g3b-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"3641ff8e872e4c90d5691edb09894914121b267e6a50455347c5f28708fa1af2"},{"host":"dv-g3c-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"23641e6de1b0c5a452bd0aaaaa1647863cf5daf27e0b62611ea9289dc0106d39"},{"host":"ov-g3b-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"402cc78d8effe1157b92fbe23ffdb860a6ac754bd126692f98d4b1d2df66e35d"},{"host":"ov-g3c-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"4cf2e52ff28f08d690046a75def341abf6508d18c197c6825c7820e0899e1c63"},{"host":"ev-g3b-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"19fcef2a9fa3ecc88294736d1bdcc2cd7c8753960ff67e8890affa13bd5ea4e5"},{"host":"ev-g3c-aaa-emudhra.we-have-a-problem.com","chainPEMSHA256":"6a3019bee019f96570bffca9002637655e7fa8221a370021ca6e0b0fd66f576d"},{"host":"dv-g3b-noct-emudhra.we-have-a-problem.com","chainPEMSHA256":"de597b4e346d6e84d264a6bc62f5cb5bf4a4d64ec5e587edc446016e4aa693c5"},{"host":"dv-g3b-aaa-noct-emudhra.we-have-a-problem.com","chainPEMSHA256":"a360266958b7dfc04250553f6a5f55be769457f126bfd4de415bbaffc9cf62ad"}];
const rows=[];
async function request(host,expected){
 await new Promise((resolve,reject)=>{
  const req=https.get({hostname:host,path:'/',method:'HEAD',headers:{'user-agent':'crabhelm37-secretless-runtime-admission'}},res=>{
   const authorized=res.socket.authorized===true;res.resume();rows.push({host,expected,outcome:'HTTP',authorized,status:res.statusCode});
   if(expected!=='authorized'||!authorized){reject(Error('Unexpected authorized connection/admission outcome for '+host));return;}resolve();
  });
  const deadline=setTimeout(()=>req.destroy(Object.assign(Error('Native TLS admission timed out'),{code:'ADMISSION_TIMEOUT'})),12000);req.on('close',()=>clearTimeout(deadline));
  req.on('error',error=>{rows.push({host,expected,outcome:'native-error',code:error.code});if(expected==='revoked'&&error.code==='CERT_REVOKED')resolve();else reject(error);});
 });
}
await request('api.github.com','authorized');
for(const row of fixtureInventory)await request(row.host,'revoked');
const receipt={pass:true,runtime:process.version,platform:process.platform,arch:process.arch,executableSHA256:createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),trustMode:'Default builtin Node CA; no overrides',credentialsDuringBuild:false,baselineReference:{scope:'Reuse existing exact oldNode22.23.1 strict certificate/hostname acceptance controls from the completed AWS lane; no new baseline or weak fixture acceptance',archiveSHA256:'7b949956955fc501a30f4d98d2f513d34c0bbbe92e29a968194c96e097ce2345',fixtures:fixtureInventory},rows};
await fs.writeFile('/opt/official-artifact/runtime-admission.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
