'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const vk=require('./vk-prefix');
const base={S3Endpoint:'https://hb.ru-msk.vkcloud-storage.ru',S3Region:'ru-msk',S3Bucket:'vets',S3Prefix:'restic',User:'apteka-test',S3AccessKeyId:'admin-access',S3SecretAccessKey:'admin-secret'};
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vk-prefix-'));try{
const req=vk.makeRequest(base,new Date('2026-10-27T12:00:00Z'));
assert(req.headers.Authorization.endsWith('Signature=d7da8abd5e6b191638e6bdf3d8a4be4af49dcd88ec27f13f0b016e315f2ddf1d'));
assert.equal(req.url,'https://vets.hb.ru-msk.vkcloud-storage.ru/?pak=&prefix=restic%2Fapteka-test%2F&username=restic-apteka-test');
assert.throws(()=>vk.makeRequest({...base,S3Endpoint:'https://example.com'}));
assert.throws(()=>vk.makeRequest({...base,User:'Apteka'}));
let calls=0;const send=async r=>{calls++;return `<CreatePrefixKeyResult><BucketName>vets</BucketName><Prefix>${r.scoped}</Prefix><UserName>${r.username}</UserName><AccessKey>point-${calls}</AccessKey><SecretKey>point-secret-${calls}</SecretKey></CreatePrefixKeyResult>`};
const a=await vk.provision(base,dir,send);assert.equal(a.accessKey,'point-1');assert.deepEqual(await vk.provision(base,dir,send),a);assert.equal(calls,1);
const b=await vk.provision({...base,User:'apteka-test2'},dir,send);assert.notEqual(a.accessKey,b.accessKey);assert(!b.prefix.startsWith(a.prefix));
const files=fs.readdirSync(path.join(dir,'restic-vk-keys'));for(const f of files){let contents=fs.readFileSync(path.join(dir,'restic-vk-keys',f),'utf8');assert(!contents.includes('admin-access'));assert(!contents.includes('admin-secret'));}
await assert.rejects(vk.provision({...base,S3AccessKeyId:'other-admin'},dir,send));
const failed={...base,User:'failed'};await assert.rejects(vk.provision(failed,dir,async()=>{throw Error('network')}));await assert.rejects(vk.provision(failed,dir,send));assert.equal(calls,2);
const wrong={...base,User:'wrong'};await assert.rejects(vk.provision(wrong,dir,async()=>'<CreatePrefixKeyResult><BucketName>vets</BucketName><Prefix>restic/other/</Prefix><UserName>restic-wrong</UserName><AccessKey>a</AccessKey><SecretKey>b</SecretKey></CreatePrefixKeyResult>'));await assert.rejects(vk.provision(wrong,dir,send));
const rejected={...base,User:'rejected'};await assert.rejects(vk.provision(rejected,dir,async()=>{throw Error('VK Cloud отклонил создание ключа (HTTP 403); проверьте ключи и состояние VK перед повтором')}));await assert.rejects(vk.provision(rejected,dir,send),/Первоначальный ответ VK Cloud: HTTP 403/);
const inspected=vk.inspectPending(rejected,dir);assert.equal(inspected.pending,true);assert.equal(inspected.identityMatches,true);assert.equal(inspected.savedCredentialExists,false);assert.match(inspected.detail,/HTTP 403/);assert(!JSON.stringify(inspected).includes('admin-secret'));assert.deepEqual(vk.inspectPending({...base,User:'never-tried'},dir),{pending:false});
const unknown={...base,User:'unknown'};await assert.rejects(vk.provision(unknown,dir,async()=>{throw Error('do-not-store-this-secret')}));await assert.rejects(vk.provision(unknown,dir,send),/Первоначальная ошибка не определена/);
for(const f of fs.readdirSync(path.join(dir,'restic-vk-keys')))assert(!fs.readFileSync(path.join(dir,'restic-vk-keys',f),'utf8').includes('do-not-store-this-secret'));
console.log('VK prefix provisioning checks passed');
}finally{fs.rmSync(dir,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
