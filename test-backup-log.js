'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
global.window={};global.document={head:{appendChild(){}},createElement:()=>({}),getElementById:()=>null};
require('./restic')({}).onWebUIStartupEnd();
const plugin=window.ResticPlugin,placeholder='C:\\Windows\\Temp\\restic-backup-log-0123456789abcdef0123456789abcdef.json';
assert.throws(()=>plugin.backupLogScript('../other',placeholder));
assert.throws(()=>plugin.backupLogScript('target',"C:\\temp\\result';bad.json"));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'restic-log-'));
try{
 const restic=path.join(root,'restic'),dir=path.join(restic,'target'),out=path.join(root,'result.json');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({User:'target',Password:'DO_NOT_RETURN'}));fs.writeFileSync(path.join(dir,'backup.ps1'),'');fs.writeFileSync(path.join(dir,'restic.exe'),'');
 fs.writeFileSync(path.join(dir,'backup_info.log'),'old line\n'.repeat(20000)+'последняя запись\n','utf8');fs.writeFileSync(path.join(dir,'backup_error.log'),'ошибка теста\n','utf8');
 function run(argument){
  let script=plugin.backupLogScript('target',placeholder).replaceAll('C:\\restic',restic.replace(/'/g,"''")).replaceAll(placeholder,out.replace(/'/g,"''"));
  const pre=`function Get-ScheduledTask {param($TaskPath,$TaskName,$ErrorAction) [pscustomobject]@{Actions=@([pscustomobject]@{Execute='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';Arguments='${argument}'})}};`;
  const r=cp.spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(pre+script,'utf16le').toString('base64')],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);let result=JSON.parse(fs.readFileSync(out,'utf8'));fs.unlinkSync(out);return result;
 }
 const result=run('-NoProfile -File "'+path.join(dir,'backup.ps1')+'"');
 assert.equal(result.status,'ok');assert.equal(result.point,'target');
 const info=result.files.find(x=>x.name==='backup_info.log'),errors=result.files.find(x=>x.name==='backup_error.log');
 assert.equal(info.state,'ok');assert.equal(info.truncated,true);assert(info.text.includes('последняя запись'));assert(Buffer.byteLength(info.text,'utf8')<=131072);
 assert.equal(errors.state,'ok');assert(errors.text.includes('ошибка теста'));assert(!JSON.stringify(result).includes('DO_NOT_RETURN'));
 const wrong=run('-Command echo '+path.join(dir,'backup.ps1'));assert.equal(wrong.status,'error');assert.equal(wrong.message,'not_found');
 fs.unlinkSync(path.join(dir,'backup_error.log'));const missing=run('-NoProfile -File "'+path.join(dir,'backup.ps1')+'"');assert.equal(missing.files.find(x=>x.name==='backup_error.log').state,'missing');
 console.log('Backup logs: selected task, bounded UTF-8 tail, missing file and unrelated task: OK');
}finally{fs.rmSync(root,{recursive:true,force:true})}
