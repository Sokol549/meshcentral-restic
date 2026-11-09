'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),zlib=require('zlib'),cp=require('child_process');
const ARCHIVE_SHA='367f618e9fcccaac4980ec12c7bafd01df739b5f3cb1af31bc9045cf75eea1d6';
function extractBw(archive,dest){
 const zip=fs.readFileSync(archive);if(crypto.createHash('sha256').update(zip).digest('hex')!==ARCHIVE_SHA)throw Error('Bitwarden CLI archive checksum mismatch');
 let end=-1;for(let p=zip.length-22;p>=Math.max(0,zip.length-65557);p--)if(zip.readUInt32LE(p)===0x06054b50){end=p;break;}if(end<0)throw Error('Invalid Bitwarden archive');
 let p=zip.readUInt32LE(end+16);const count=zip.readUInt16LE(end+10);let binary;
 for(let i=0;i<count;i++){if(zip.readUInt32LE(p)!==0x02014b50)throw Error('Invalid archive directory');let method=zip.readUInt16LE(p+10),size=zip.readUInt32LE(p+20),length=zip.readUInt32LE(p+24),nl=zip.readUInt16LE(p+28),el=zip.readUInt16LE(p+30),cl=zip.readUInt16LE(p+32),local=zip.readUInt32LE(p+42),name=zip.subarray(p+46,p+46+nl).toString();if(name==='bw'){if(length>200000000||zip.readUInt32LE(local)!==0x04034b50)throw Error('Invalid CLI binary');let at=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28),bytes=zip.subarray(at,at+size);binary=method===8?zlib.inflateRawSync(bytes,{maxOutputLength:200000000}):method===0?bytes:null;if(!binary||binary.length!==length)throw Error('Invalid CLI binary');}p+=46+nl+el+cl;}
 if(!binary)throw Error('Bitwarden CLI is missing from archive');fs.writeFileSync(dest,binary,{mode:0o700,flag:'wx'});
}
function command(binary,args,env,input){return new Promise((resolve,reject)=>{const child=cp.spawn(binary,args,{env,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;const timer=setTimeout(()=>child.kill('SIGKILL'),60000);child.stdout.on('data',d=>{stdout+=d;if(stdout.length>25000000)child.kill('SIGKILL');});child.stderr.on('data',d=>{stderr+=d;if(stderr.length>10000)stderr=stderr.slice(0,10000);});child.on('error',()=>{if(!done){done=true;clearTimeout(timer);reject(Error('Cannot start Bitwarden CLI'));}});child.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code!==0)reject(Error('Bitwarden CLI returned an error (check login, master password and two-factor settings)'));else resolve(stdout.trim());});child.stdin.on('error',()=>{});child.stdin.end(input||'');});}
function createVault(options={}){
 const sessions=new WeakMap(),run=options.run||command;
 async function unlock(client,credentials,master){
  if(!options.prepare&&(process.platform!=='linux'||process.arch!=='x64'))throw Error('Bundled Bitwarden CLI requires Linux x64');
  if(!credentials||typeof credentials.id!=='string'||typeof credentials.secret!=='string'||!credentials.id||!credentials.secret||typeof master!=='string'||!master)throw Error('Enter API client ID, API client secret and master password');
  await lock(client);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-restic-bw-'));fs.chmodSync(dir,0o700);const bin=path.join(dir,'bw');
  try{
   if(options.prepare)await options.prepare(bin);else extractBw(path.join(__dirname,'bw-linux-2026.8.0.zip'),bin);
   const env={...process.env,BITWARDENCLI_APPDATA_DIR:path.join(dir,'data'),BW_CLIENTID:credentials.id,BW_CLIENTSECRET:credentials.secret,RESTIC_BW_MASTER:master};delete env.BW_SESSION;
   await run(bin,['config','server','https://vw.it.kzvs.pro'],env);await run(bin,['login','--apikey'],env);
   const status=JSON.parse(await run(bin,['status'],env));if(String(status.userEmail||'').toLowerCase()!=='sokol@kzvs.pro')throw Error('API key belongs to a different Vaultwarden account');
   const session=await run(bin,['unlock','--passwordenv','RESTIC_BW_MASTER','--raw'],env);if(!session)throw Error('Vault unlock did not return a session');
   delete env.BW_CLIENTID;delete env.BW_CLIENTSECRET;delete env.RESTIC_BW_MASTER;env.BW_SESSION=session;
   await run(bin,['sync'],env);const folders=JSON.parse(await run(bin,['list','folders'],env));const matches=folders.filter(x=>x.name==='Vets_Backup');if(matches.length!==1)throw Error('Folder Vets_Backup was not found or is ambiguous');
   const item={dir,bin,env,folderId:matches[0].id};sessions.set(client,item);item.timer=setTimeout(()=>{lock(client).catch(()=>{});},2*60*60*1000);if(item.timer.unref)item.timer.unref();return true;
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
 }
 async function lock(client){const item=sessions.get(client);if(!item)return;sessions.delete(client);clearTimeout(item.timer);try{await run(item.bin,['logout'],item.env);}catch(e){}delete item.env.BW_SESSION;fs.rmSync(item.dir,{recursive:true,force:true});}
 async function find(client,user){
  const s=sessions.get(client);if(!s)throw Error('Сначала разблокируйте Vaultwarden');if(typeof user!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(user))throw Error('Некорректный идентификатор точки');
  await run(s.bin,['sync'],s.env);const items=JSON.parse(await run(s.bin,['list','items'],s.env));const matches=items.filter(x=>x.folderId===s.folderId&&(x.name==='Restic: '+user||(x.login&&x.login.username===user)));if(matches.length>1)throw Error('В Vets_Backup найдено несколько записей этой точки; проверьте их вручную');if(!matches.length)return null;const entry=matches[0];if(!entry.login||entry.login.username!==user||typeof entry.login.password!=='string'||!entry.login.password)throw Error('Запись точки в Vets_Backup не содержит подходящий логин и пароль');return entry.login.password;
 }
 async function save(client,user,password){
  const s=sessions.get(client);if(!s)throw Error('Unlock Vaultwarden first');if(typeof user!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(user)||typeof password!=='string'||!password)throw Error('Invalid point identifier or password');
  const name='Restic: '+user;const existing=await find(client,user);if(existing!==null){if(existing===password)return;throw Error('Для этой точки уже сохранён другой пароль: используйте существующий пароль или другой идентификатор');}
  const item=JSON.parse(await run(s.bin,['get','template','item'],s.env)),login=JSON.parse(await run(s.bin,['get','template','item.login'],s.env));item.name=name;item.folderId=s.folderId;item.type=1;login.username=user;login.password=password;item.login=login;
  let created;try{created=JSON.parse(await run(s.bin,['create','item'],s.env,Buffer.from(JSON.stringify(item)).toString('base64')));}catch(e){throw Error('Vault save result is unknown; check Vets_Backup before retrying');}
  if(!created.id)throw Error('Vault save result is unknown; check Vets_Backup before retrying');
  const verify=JSON.parse(await run(s.bin,['get','item',created.id],s.env));if(verify.folderId!==s.folderId||verify.name!==name||!verify.login||verify.login.password!==password)throw Error('Could not verify saved vault entry');
 }
 return {unlock,save,find,lock};
}
module.exports={createVault,extractBw};
