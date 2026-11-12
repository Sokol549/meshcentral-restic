'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),vk=require('./vk-prefix');
const config={S3Endpoint:'https://hb.ru-msk.vkcloud-storage.ru',S3Region:'ru-msk',S3Bucket:'vets',S3Prefix:'',User:'point',S3AccessKeyId:'id',S3SecretAccessKey:'secret'};
const list=(entries='',truncated='false')=>'<ListPrefixKeysResult><BucketName>vets</BucketName><IsTruncated>'+truncated+'</IsTruncated>'+entries+'</ListPrefixKeysResult>';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'restic-recover-'));
async function lock(name,old=true){
 const c={...config,User:name};await assert.rejects(vk.provision(c,root,async()=>{throw Error('network')}));
 const dir=path.join(root,'restic-vk-keys'),lock=fs.readdirSync(dir).filter(x=>x.endsWith('.pending')).map(x=>path.join(dir,x)).find(p=>JSON.parse(fs.readFileSync(p)).username==='restic-'+name);
 if(old){const t=new Date(Date.now()-3600000);fs.utimesSync(lock,t,t);}
 return {c,lock,stamp:vk.inspectPending(c,root).modifiedAt};
}
(async()=>{try{
 let x=await lock('fresh',false);await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>list()),/ещё выполняться/);assert(fs.existsSync(x.lock));
 x=await lock('exists');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>list('<Contents><UserName>restic-exists</UserName><Prefix>exists/</Prefix></Contents>')),/существует/);assert(fs.existsSync(x.lock));
 x=await lock('partial');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>list('','true')),/неполный/);assert(fs.existsSync(x.lock));
 x=await lock('malformed');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>list('<Contents><Prefix>x</Prefix></Contents>')),/некорректный/);assert(fs.existsSync(x.lock));
 x=await lock('changed');await assert.rejects(vk.archivePending(x.c,root,'2000-01-01T00:00:00.000Z',async()=>list()),/изменилось/);assert(fs.existsSync(x.lock));
 x=await lock('saved');fs.writeFileSync(x.lock.replace(/\.pending$/,'.json'),'{}');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>list()),/изменилось/);assert(fs.existsSync(x.lock));
 x=await lock('race');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>{fs.writeFileSync(x.lock.replace(/\.pending$/,'.json'),'{}');return list()}),/изменилось/);assert(fs.existsSync(x.lock));
 x=await lock('offline');await assert.rejects(vk.archivePending(x.c,root,x.stamp,async()=>{throw Error('network')}));assert(fs.existsSync(x.lock));
 x=await lock('ready');let result=await vk.archivePending(x.c,root,x.stamp,async req=>{assert(req.url.endsWith('/?pak='));return list('<Contents><UserName>restic-other</UserName><Prefix>other/</Prefix></Contents>')});assert(result.archived);assert(!fs.existsSync(x.lock));assert(fs.readdirSync(path.dirname(x.lock)).some(n=>n.includes('.archived-')));
 console.log('Pending recovery: stale, exact, absent, complete response and retained archive: OK');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
