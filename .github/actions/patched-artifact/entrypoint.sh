#!/bin/bash
set -euo pipefail
node - <<'JS'
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
assert.equal(process.version,'v24.22.1');assert.equal(process.arch,'x64');
for(const key of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_USE_SYSTEM_CA','NODE_TLS_REJECT_UNAUTHORIZED'])assert.ok(!process.env[key],'Artifact transport trust mode differs from secretless admission: '+key);
const admitted=JSON.parse(fs.readFileSync('/opt/official-artifact/runtime-admission.json','utf8'));assert.equal(admitted.pass,true);assert.equal(admitted.executableSHA256,crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'));console.log(JSON.stringify(admitted));
console.log(JSON.stringify({artifactTransportRuntime:process.version,architecture:process.arch,executableSHA256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),operation:process.env.INPUT_OPERATION,scope:'Official byte-pinned artifact script under patched immutable container runtime; native product/systemd runs on hosted VM separately'}));
JS
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const e=process.env,token=e['INPUT_GITHUB-TOKEN'];
if(e.INPUT_OPERATION==='download'&&token){
 assert.equal(e.INPUT_REPOSITORY,'openclaw/crabhelm');assert.equal(e['INPUT_RUN-ID'],'39894679029');assert.equal(e['INPUT_ARTIFACT-IDS'],'12476682095');assert.equal(e['INPUT_DIGEST-MISMATCH'],'error');
 const response=await fetch('https://api.github.com/repos/openclaw/crabhelm/actions/artifacts/12476682095',{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}});
 assert.equal(response.status,200,'Fixed source artifact metadata admission failed');const m=await response.json();
 assert.equal(m.id,12476682095);assert.equal(m.name,'crabhelm37-reviewed-inputs-39894679029');assert.equal(m.expired,false);assert.equal(m.digest,'sha256:094ca3420aafe644ec289e79fda12c34f21da5b1e4ee80233d64f6519dd5bf80');assert.equal(m.size_in_bytes,89926841);
 assert.equal(m.workflow_run.id,39894679029);assert.equal(m.workflow_run.repository_id,1287009246);assert.equal(m.workflow_run.head_repository_id,1287009246);assert.equal(m.workflow_run.head_sha,'d1713461dffd7bb42da64f01bcd4ae14c4a1119c');assert.equal(m.workflow_run.head_branch,'security/emudhra-node-release');
 console.log(JSON.stringify({artifactSourceAdmission:'pass',artifactID:m.id,digest:m.digest,runID:m.workflow_run.id,sourceHead:m.workflow_run.head_sha,repositoryID:m.workflow_run.repository_id}));
}
JS
case "${INPUT_OPERATION:?missing operation}" in
 upload) exec node /opt/official-artifact/upload.mjs ;;
 download) exec node /opt/official-artifact/download.mjs ;;
 *) printf '%s\n' 'Only fixed upload/download operations are supported' >&2; exit 2 ;;
esac
