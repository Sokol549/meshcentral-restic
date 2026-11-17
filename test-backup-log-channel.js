'use strict';
const assert=require('assert');let onText,onBinary,sent,mode='success',removed=false,previousCalls=0;
const area={value:'',scrollTop:0,scrollHeight:1},panel={hidden:true},status={textContent:''};
global.window={};global.document={head:{appendChild(){}},createElement:()=>({}),getElementById:id=>({'restic-backup-log':area,'restic-backup-log-panel':panel,'restic-tasks-status':status}[id]||null)};
const old=()=>{previousCalls++};global.meshserver={onMessage:old,send:m=>{sent=m;if(mode==='denied')queueMicrotask(()=>meshserver.onMessage(null,{action:'runcommands',responseid:m.responseid,result:'Access denied'}));}};
global.CreateRemoteFiles=(a,b)=>{onText=a;onBinary=b;return {}};
global.serverPublicNamePort='';global.authCookie='';global.authRelayCookie='';global.domainUrl='';
global.CreateAgentRedirect=()=>({Start(){this.onStateChanged(this,3)},Stop(){},sendText(raw){
 const m=JSON.parse(raw);
 if(m.action==='ls'&&mode!=='denied')queueMicrotask(()=>{const script=Buffer.from(sent.cmds.split(' ').pop(),'base64').toString('utf16le'),name=script.match(/restic-backup-log-[a-f0-9]+\.json/)[0];onText(JSON.stringify({reqid:230,dir:[{n:name}]}));});
 if(m.action==='download'&&m.sub==='start')queueMicrotask(()=>onText(JSON.stringify({action:'download',sub:'start',id:m.id})));
 if(m.action==='download'&&m.sub==='startack')queueMicrotask(()=>{
  const value={point:mode==='mismatch'?'other':'target',status:'ok',files:[{name:'backup_info.log',state:'ok',text:'информация',truncated:true},{name:'backup_error.log',state:'missing',text:''}]},b=Buffer.from(JSON.stringify(value)),mid=Math.floor(b.length/2);
  onBinary(Buffer.concat([Buffer.from([0,0,0,0]),b.subarray(0,mid)]));onBinary(Buffer.concat([Buffer.from([0,0,0,1]),b.subarray(mid)]));
 });
 if(m.action==='rm')removed=true;
}});
require('./restic')({}).onWebUIStartupEnd();const plugin=window.ResticPlugin;
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
(async()=>{
 plugin.readBackupLog('node','target');await tick();
 assert.equal(status.textContent,'Журнал загружен.');assert(area.value.includes('информация'));assert(area.value.includes('Показан конец файла'));assert(area.value.includes('Файл ещё не создан.'));assert(!panel.hidden);assert(removed);assert.equal(meshserver.onMessage,old);
 mode='mismatch';plugin.readBackupLog('node','target');await tick();assert(!area.value.includes('информация'));assert.equal(plugin._backupLogBusy,false);
 mode='denied';plugin.readBackupLog('node','target');await tick();assert(area.value.includes('Нет права'));assert.equal(meshserver.onMessage,old);assert(previousCalls);
 console.log('Backup log channel: chunking, selected-point validation and access denial: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
