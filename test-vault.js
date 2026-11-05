'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {createVault,extractBw}=require('./vault');
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bw-extract-test-'));
 try{extractBw(path.join(__dirname,'bw-linux-2026.8.0.zip'),path.join(temp,'bw'));assert(fs.statSync(path.join(temp,'bw')).size>1000000);}finally{fs.rmSync(temp,{recursive:true,force:true});}
 let items=[];const run=async(bin,args,env,input)=>{
  if(args[0]==='config'||args[0]==='login'||args[0]==='sync'||args[0]==='logout')return '';
  if(args[0]==='status')return JSON.stringify({userEmail:'sokol@kzvs.pro'});
  if(args[0]==='unlock'){assert.equal(env.RESTIC_BW_MASTER,'master-test');return 'session-test';}
  assert.equal(env.BW_SESSION,'session-test');assert(!('RESTIC_BW_MASTER' in env));
  if(args[0]==='list'&&args[1]==='folders')return JSON.stringify([{name:'Vets_Backup',id:'folder'}]);
  if(args[0]==='list'&&args[1]==='items')return JSON.stringify(items);
  if(args[0]==='get'&&args[1]==='template')return '{}';
  if(args[0]==='create'){let item=JSON.parse(Buffer.from(input,'base64'));item.id='created-id';items.push(item);return JSON.stringify(item);}
  if(args[0]==='get'&&args[1]==='item')return JSON.stringify(items[0]);
  throw Error('Unexpected command');
 };
 const vault=createVault({run,prepare:async()=>{}}),client={};
 await assert.rejects(()=>vault.save(client,'point','password'));await vault.unlock(client,{id:'id',secret:'secret'},'master-test');await vault.save(client,'point','password');assert.equal(items[0].folderId,'folder');assert.equal(items[0].login.password,'password');await vault.save(client,'point','password');assert.equal(items.length,1);await assert.rejects(()=>vault.save(client,'point','changed'));await vault.lock(client);await assert.rejects(()=>vault.save(client,'point','password'));console.log('Pinned CLI archive, vault unlock, save, verification, duplicate protection and lock: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
