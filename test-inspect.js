'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const vk=require('./vk-prefix');
const config={S3Endpoint:'https://hb.ru-msk.vkcloud-storage.ru',S3Region:'ru-msk',S3Bucket:'vets',S3Prefix:'',User:'test-point',S3AccessKeyId:'admin-id',S3SecretAccessKey:'admin-secret'};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restic-inspect-'));
 try{
  await assert.rejects(vk.provision(config,dir,async()=>{throw Error('failure')}));
  let reply;const client={user:{_id:'user',siteadmin:0xffffffff},send:m=>{reply=m}};
  const plugin=require('./restic')({parent:{datapath:dir}});
  plugin.serveraction({pluginaction:'inspectPending',requestId:'r1',config},client);
  assert.equal(reply.method,'onSettings');assert.equal(reply.requestId,'r1');assert.equal(reply.inspection.pending,true);
  assert.equal(reply.inspection.identityMatches,true);assert(!JSON.stringify(reply).includes('admin-secret'));
  client.user.siteadmin=0;plugin.serveraction({pluginaction:'inspectPending',requestId:'r2',config},client);
  assert(reply.error);assert(!reply.inspection);
  console.log('Pending-key inspection is read-only, redacted and admin-only: OK');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
