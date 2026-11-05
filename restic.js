'use strict';
const {build}=require('./builder');
module.exports=function(parent){
 const obj={}; const jobs=new WeakMap();
 obj.exports=['onWebUIStartupEnd','onDeviceRefreshEnd','onPackageChunk'];
 obj.serveraction=function(cmd,client){
  if(!client || !client.user || ![0xffffffff,-1].includes(client.user.siteadmin)) { if(client && client.send) client.send({action:'plugin',plugin:'restic',method:'onPackageChunk',error:'Требуются полные права администратора MeshCentral.'}); return; }
  const reply=(m)=>client.send(Object.assign({action:'plugin',plugin:'restic',method:'onPackageChunk'},m));
  try {
   if(cmd.pluginaction==='build'){
    if(jobs.has(client)) throw Error('Сборка уже выполняется.');
    const data=build(cmd.config); const item={data:data,offset:0,expires:Date.now()+300000}; jobs.set(client,item);
    const timer=setTimeout(()=>{if(jobs.get(client)===item) jobs.delete(client);},300000); if(timer.unref) timer.unref();
    reply({ready:true,size:data.length});
   } else if(cmd.pluginaction==='next'){
    const item=jobs.get(client); if(!item || Date.now()>item.expires){jobs.delete(client); throw Error('Время получения пакета истекло.');}
    const part=item.data.subarray(item.offset,item.offset+196608); item.offset+=part.length; const done=item.offset===item.data.length;
    reply({data:part.toString('base64'),offset:item.offset,total:item.data.length,done:done}); if(done) jobs.delete(client);
   } else if(cmd.pluginaction==='cancel'){jobs.delete(client);}
  }catch(e){jobs.delete(client); reply({error:e.message});}
 };
 obj.onWebUIStartupEnd=function(){
  if(window.ResticPlugin)return;
  window.ResticPlugin={
   send:function(action,extra){meshserver.send(Object.assign({action:'plugin',plugin:'restic',pluginaction:action},extra||{}));},
   status:function(t){var e=document.getElementById('restic-status');if(e)e.textContent=t;},
   inject:function(){var target=document.getElementById('p10info');if(!target||document.getElementById('restic-open'))return;var b=document.createElement('button');b.id='restic-open';b.textContent='Настроить бекап';b.style.margin='8px';b.onclick=this.open.bind(this);target.insertBefore(b,target.firstChild);},
   open:function(){
    if(document.getElementById('restic-overlay'))return;
    var n=window.currentNode;if(!n || !n._id){alert('Откройте карточку компьютера.');return;}
    var overlay=document.createElement('div');overlay.id='restic-overlay';overlay.style.cssText='position:fixed;inset:0;background:#0009;z-index:100000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML=`<form id="restic-form" style="background:white;color:black;padding:24px;max-width:520px;width:90%;max-height:90vh;overflow:auto;font:14px sans-serif"><h2>????????? ?????</h2><p id="restic-node"></p><label>????????????? ????? <input name="user" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" style="width:100%"></label><br><br><label>?????? Restic / REST <input name="password" type="password" required autocomplete="new-password" style="width:100%"></label><br><br><label>????????? <select name="storage" id="restic-storage"><option value="Rest">REST</option><option value="S3">S3</option></select></label><br><br><div id="restic-rest"><label>????? REST-??????? <input name="url" type="url" placeholder="https://" style="width:100%"></label><br><br></div><div id="restic-s3" style="display:none"><label>????? S3 <input name="endpoint" type="url" placeholder="https://" style="width:100%"></label><br><label>?????? <input name="region" style="width:100%"></label><br><label>Bucket <input name="bucket" style="width:100%"></label><br><label>??????? <input name="prefix" value="restic" style="width:100%"></label><br><label>Access key <input name="access" style="width:100%"></label><br><label>Secret key <input name="secret" type="password" autocomplete="new-password" style="width:100%"></label><br><br></div><label>???? ? ???? ?? Windows <input name="source" required value="C:\\???? ???????\\1Cv8.1CD" style="width:100%"></label><br><br><label>????? ????????, ??/? <input name="limit" type="number" min="1" value="350"></label><br><label>???????? ?? ?????, ?? <input name="free" type="number" min="1" value="40"></label><br><label>??????? ?????? <input name="full" type="number" min="1" value="3"></label><br><label>???????????? ???????? <input name="incremental" type="number" min="0" value="6"></label><p>??????? ?????? REST ??? ????? S3 ??? ?????? ????????????. ????????? ?????? ????????: ?? ??????????? ??? ??????????????.</p><p id="restic-status" role="status"></p><button type="submit">??????? ? ??????????</button> <button type="button" id="restic-close">???????</button></form>`;
    document.body.appendChild(overlay);document.getElementById('restic-node').textContent='Компьютер: '+(n.name||n._id);var self=this;
    document.getElementById('restic-storage').onchange=function(){document.getElementById('restic-rest').style.display=this.value==='Rest'?'':'none';document.getElementById('restic-s3').style.display=this.value==='S3'?'':'none';};
    document.getElementById('restic-close').onclick=function(){if(self.busy){alert('Дождитесь завершения операции.');return;}overlay.remove();};
    document.getElementById('restic-form').onsubmit=function(e){e.preventDefault();if(self.busy)return; var f=e.target;var node=n._id;if(!confirm('Создать пакет и запустить установку на выбранном компьютере?'))return;self.busy=true;self.node=node;self.parts=[];self.status('Создание пакета…');self.timer=setTimeout(function(){self.fail('Сервер не ответил вовремя.');},120000);self.send('build',{config:{User:f.user.value,Password:f.password.value,SourcePath:f.source.value,StorageType:f.storage.value,ServerUrl:f.url.value,S3Endpoint:f.endpoint.value,S3Region:f.region.value,S3Bucket:f.bucket.value,S3Prefix:f.prefix.value,S3AccessKeyId:f.access.value,S3SecretAccessKey:f.secret.value,UploadLimitKbps:f.limit.value,MinFreeHddGb:f.free.value,RetentionFullCount:f.full.value,RetentionIncrementalCount:f.incremental.value}});f.password.value='';f.secret.value='';};
   },
   fail:function(error){clearTimeout(this.timer);this.busy=false;this.parts=[];this.status('Ошибка: '+error);try{this.send('cancel');}catch(e){}},
   chunk:function(m){if(!this.busy)return;if(m.error){this.fail(m.error);return;}if(m.ready){this.send('next');return;}if(typeof m.data!=='string'){this.fail('Некорректный ответ сервера.');return;}var s=atob(m.data),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);this.parts.push(a);this.status('Получение пакета: '+Math.round(100*m.offset/m.total)+'%');if(!m.done){this.send('next');return;}clearTimeout(this.timer);var file=new Blob(this.parts,{type:'application/octet-stream'});this.parts=[];this.upload(file);},
   upload:function(file){
    var self=this,dir='C:/Windows/System32/config/systemprofile/AppData/Local/Temp',id=Array.from(crypto.getRandomValues(new Uint8Array(16)),function(x){return x.toString(16).padStart(2,'0');}).join(''),name='restic-'+id+'.exe',offset=0,done=false,redirect,timer;
    function finish(err){if(done)return;done=true;clearTimeout(timer);if(err){try{redirect.sendText(JSON.stringify({action:'rm',reqid:9,path:dir,delfiles:[name],rec:false}));}catch(e){}}try{redirect.Stop();}catch(e){}if(err)self.fail(err);else self.run(dir,name,id);}
    function touch(){clearTimeout(timer);timer=setTimeout(function(){finish('Превышено время передачи файла.');},60000);}
    function send(m){redirect.sendText(JSON.stringify(m));}
    function next(){if(offset>=file.size){send({action:'uploaddone',reqid:1});return;}var reader=new FileReader();reader.onerror=function(){finish('Не удалось прочитать пакет.');};reader.onload=function(){var bytes=new Uint8Array(reader.result);if(bytes.length&&(bytes[0]===0||bytes[0]===123)){var frame=new Uint8Array(bytes.length+1);frame.set(bytes,1);redirect.send(frame);}else redirect.send(bytes);offset+=bytes.length;self.status('Передача на компьютер: '+Math.round(offset*100/file.size)+'%');touch();};reader.readAsArrayBuffer(file.slice(offset,Math.min(offset+65536,file.size)));}
    var protocol=CreateRemoteFiles(function(data){var m=data;try{if(typeof m==='string')m=JSON.parse(m);}catch(e){return;}if(!m||Number(m.reqid)!==1)return;touch();if(m.action==='uploadstart'||m.action==='uploadack')next();else if(m.action==='uploaddone')finish();else if(m.action==='uploaderror')finish('Агент не смог записать пакет. Проверьте права SYSTEM.');});
    redirect=CreateAgentRedirect(meshserver,protocol,serverPublicNamePort,authCookie,authRelayCookie,domainUrl);redirect.onStateChanged=function(x,state){if(state===3){touch();send({action:'upload',reqid:1,path:dir,name:name,size:file.size});}else if(state===0&&!done)finish('Файловое соединение прервано.');};touch();try{redirect.Start(self.node);}catch(e){finish(e.message);}
   },
   run:function(dir,name,id){
    var self=this;self.status('Пакет передан. Запуск установки…');
    var exe=(dir+'/'+name).replace(/\//g,'\\'), marker=(dir+'/restic-'+id).replace(/\//g,'\\');
    var script="$p='"+exe+"';$m='"+marker+"';try{& $p initialize;$c=$LASTEXITCODE;if($null -eq $c){$c=1}}catch{$c=1}finally{Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue};if($c -eq 0){New-Item -ItemType File -Force -Path ($m+'.ok') | Out-Null}else{New-Item -ItemType File -Force -Path ($m+'.failed') | Out-Null}";
    var encoded=btoa(unescape(encodeURIComponent(script)).split('').map(function(c){return c+'\0';}).join(''));
    try{meshserver.send({action:'runcommands',nodeids:[self.node],type:1,runAsUser:0,cmds:'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+encoded});}catch(e){self.fail(e.message);return;}
    var redirect,ended=false,start=Date.now(),interval,timer;
    function finish(msg){if(ended)return;ended=true;clearInterval(interval);clearTimeout(timer);try{redirect.Stop();}catch(e){}self.busy=false;self.status(msg);}
    function query(){if(Date.now()-start>600000){finish('Результат неизвестен: время ожидания истекло. Проверьте терминал и журналы на компьютере.');return;}try{redirect.sendText(JSON.stringify({action:'ls',reqid:2,path:dir}));}catch(e){finish('Результат неизвестен: файловое соединение прервано.');}}
    var protocol=CreateRemoteFiles(function(data){var m=data;try{if(typeof m==='string')m=JSON.parse(m);}catch(e){return;}if(!m||Number(m.reqid)!==2||!Array.isArray(m.dir))return;var ok='restic-'+id+'.ok',bad='restic-'+id+'.failed';var hit=m.dir.find(function(x){return x.n===ok||x.n===bad;});if(hit){try{redirect.sendText(JSON.stringify({action:'rm',reqid:3,path:dir,delfiles:[hit.n],rec:false}));}catch(e){}finish(hit.n===ok?'Установка завершена успешно. Проверьте первый бекап и журналы на компьютере.':'Установка завершилась с ошибкой. Проверьте журналы и терминал компьютера.');}});
    redirect=CreateAgentRedirect(meshserver,protocol,serverPublicNamePort,authCookie,authRelayCookie,domainUrl);redirect.onStateChanged=function(x,state){if(state===3){clearTimeout(timer);query();interval=setInterval(query,5000);}else if(state===0&&!ended)finish('Результат неизвестен: файловое соединение прервано.');};timer=setTimeout(function(){finish('Результат неизвестен: не удалось подключить файловый канал.');},30000);try{redirect.Start(self.node);}catch(e){finish('Результат неизвестен: '+e.message);}
   }
  };window.ResticPlugin.inject();
 };
 obj.onDeviceRefreshEnd=function(){if(window.ResticPlugin)window.ResticPlugin.inject();};
 obj.onPackageChunk=function(server,message){var m=message||server;if(window.ResticPlugin)window.ResticPlugin.chunk(m);};
 return obj;
};
module.exports.restic=module.exports;
