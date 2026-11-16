'use strict';
const assert=require('assert'),cp=require('child_process');
let sent,callback;
global.window={};
global.document={head:{appendChild(){}},createElement:()=>({}),getElementById:()=>null};
global.meshserver={send:m=>{sent=m}};
global.serverPublicNamePort='';global.authCookie='';global.authRelayCookie='';global.domainUrl='';
global.CreateRemoteFiles=fn=>{callback=fn;return {}};
global.CreateAgentRedirect=()=>({Start(){this.onStateChanged(this,3)},Stop(){},sendText(raw){let m=JSON.parse(raw);if(m.action==='ls')queueMicrotask(()=>{let s=Buffer.from(sent.cmds.split(' ').pop(),'base64').toString('utf16le'),p=s.match(/restic-tasks-[a-f0-9]+/)[0];callback(JSON.stringify({reqid:91,dir:[{n:p+'.missing'}]}));})}});
require('./restic')({}).onWebUIStartupEnd();
window.ResticPlugin.manageTasks('node','start','target');
assert.equal(sent.type,1);
const script=Buffer.from(sent.cmds.split(' ').pop(),'base64').toString('utf16le');
function run(state,argument,fail,extraAction){
 const pre=`$global:task=[pscustomobject]@{TaskPath='\\';TaskName='ResticBackup_target';State='${state}';Actions=@([pscustomobject]@{Execute='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';Arguments='${argument}'})};$global:started=0;$global:markers=@();function Get-ScheduledTask {param($TaskPath,$TaskName,$ErrorAction) $global:task};function Test-Path {param($LiteralPath) return $true};function Get-Content {param($LiteralPath,[switch]$Raw,$Encoding) '{"User":"target"}'};function Start-ScheduledTask {param($InputObject,$ErrorAction) ${fail?"throw 'failure'":"$global:started++"}};function New-Item {param($ItemType,[switch]$Force,$Path) $global:markers+= $Path};`;
 const extra=extraAction?"$global:task.Actions += [pscustomobject]@{Execute='cmd.exe';Arguments='/c echo unrelated'};":'';
 const all=pre+extra+script+`;[Console]::Out.WriteLine((@{started=$global:started;markers=$global:markers}|ConvertTo-Json -Compress))`;
 const r=cp.spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(all,'utf16le').toString('base64')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());
}
const valid='-NoProfile -File "C:\\restic\\target\\backup.ps1"';
for(const [state,marker] of [['Running','.running'],['Queued','.running'],['Disabled','.disabled'],['Unknown','.notready']]){const r=run(state,valid,false);assert.equal(r.started,0);assert(r.markers[0].endsWith(marker));}
let wrong=run('Ready','-Command echo C:\\restic\\target\\backup.ps1',false);assert.equal(wrong.started,0);assert(wrong.markers[0].endsWith('.missing'));
let multiple=run('Ready',valid,false,true);assert.equal(multiple.started,0);assert(multiple.markers[0].endsWith('.missing'));
let ok=run('Ready',valid,false);assert.equal(ok.started,1);assert(ok.markers[0].endsWith('.started'));
let failed=run('Ready',valid,true);assert.equal(failed.started,0);assert(failed.markers[0].endsWith('.error'));
console.log('Manual start: only the selected ready Restic task runs; failure and other states are reported: OK');
