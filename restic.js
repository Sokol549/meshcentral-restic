'use strict';
const {build}=require('./builder');
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const vault=require('./vault').createVault();
module.exports=function(parent){
 const obj={}; const jobs=new WeakMap();
 const settingsFields=['S3Endpoint','S3Region','S3Bucket','S3Prefix','S3AccessKeyId','S3SecretAccessKey','Password','SourcePath','UploadLimitKbps','MinFreeHddGb','RetentionFullCount','RetentionIncrementalCount','VaultClientId','VaultClientSecret'];
 const verified=new WeakMap(),pending=new WeakSet();
 obj.exports=['onWebUIStartupEnd','onDeviceRefreshEnd','onPackageChunk','onSettings','onVault'];
 obj.serveraction=function(cmd,client){
  if(!client || !client.user || ![0xffffffff,-1].includes(client.user.siteadmin)) { if(client && client.send) client.send({action:'plugin',plugin:'restic',method:(cmd.pluginaction==='loadSettings'||cmd.pluginaction==='saveSettings')?'onSettings':(cmd.pluginaction==='unlockVault'||cmd.pluginaction==='saveVault')?'onVault':'onPackageChunk',error:'Требуются полные права администратора MeshCentral.'}); return; }
  const reply=(m)=>client.send(Object.assign({action:'plugin',plugin:'restic',method:'onPackageChunk'},m));
  const settingsReply=(m)=>client.send(Object.assign({action:'plugin',plugin:'restic',method:'onSettings'},m));
  const vaultReply=(m)=>client.send(Object.assign({action:'plugin',plugin:'restic',method:'onVault'},m));
  try {
   if(cmd.pluginaction==='unlockVault'||cmd.pluginaction==='saveVault'){
    if(pending.has(client))throw Error('Another vault request is in progress');pending.add(client);
    if(cmd.pluginaction==='unlockVault'){
     verified.delete(client);vault.unlock(client,{id:cmd.clientId,secret:cmd.clientSecret},cmd.master).then(()=>vaultReply({unlocked:true})).catch(e=>vaultReply({error:e.message})).finally(()=>pending.delete(client));
    }else{
     verified.delete(client);const id=cmd.id,password=cmd.password;vault.save(client,id,password).then(()=>{verified.set(client,crypto.createHash('sha256').update(JSON.stringify([id,password])).digest('hex'));vaultReply({saved:true});}).catch(e=>vaultReply({error:e.message})).finally(()=>pending.delete(client));
    }
   } else if(cmd.pluginaction==='loadSettings'||cmd.pluginaction==='saveSettings'){
    const server=parent.parent||parent.meshServer;
    if(!server||!server.datapath||!client.user._id)throw Error('Settings storage is unavailable');
    const directory=path.join(server.datapath,'restic-settings');
    const filename=path.join(directory,crypto.createHash('sha256').update(client.user._id).digest('hex')+'.json');
    if(cmd.pluginaction==='loadSettings'){
     let values={};try{values=JSON.parse(fs.readFileSync(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
     const filtered={};for(const key of settingsFields)if(typeof values[key]==='string')filtered[key]=values[key];
     settingsReply({settings:filtered});
    }else{
     if(!cmd.settings||typeof cmd.settings!=='object')throw Error('Invalid settings');
     const values={};for(const key of settingsFields){const value=cmd.settings[key];if(typeof value!=='string'||value.length>4096)throw Error('Invalid settings');values[key]=value;}
     fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
     const temporary=path.join(directory,crypto.randomBytes(16).toString('hex')+'.tmp');
     try{fs.writeFileSync(temporary,JSON.stringify(values),{mode:0o600,flag:'wx'});fs.renameSync(temporary,filename);}finally{try{fs.unlinkSync(temporary);}catch(e){}}
     settingsReply({saved:true});
    }
   } else if(cmd.pluginaction==='build'){
    if(!cmd.config||verified.get(client)!==crypto.createHash('sha256').update(JSON.stringify([cmd.config.User,cmd.config.Password])).digest('hex'))throw Error('Сначала сохраните пароль этой точки в Vaultwarden');
    if(jobs.has(client)) throw Error('Сборка уже выполняется.');
    const data=build(cmd.config); const item={data:data,offset:0,expires:Date.now()+300000}; jobs.set(client,item);
    const timer=setTimeout(()=>{if(jobs.get(client)===item) jobs.delete(client);},300000); if(timer.unref) timer.unref();
    reply({ready:true,size:data.length});
   } else if(cmd.pluginaction==='next'){
    const item=jobs.get(client); if(!item || Date.now()>item.expires){jobs.delete(client); throw Error('Время получения пакета истекло.');}
    const part=item.data.subarray(item.offset,item.offset+196608); item.offset+=part.length; const done=item.offset===item.data.length;
    reply({data:part.toString('base64'),offset:item.offset,total:item.data.length,done:done}); if(done) jobs.delete(client);
   } else if(cmd.pluginaction==='cancel'){jobs.delete(client);}
  }catch(e){if(cmd.pluginaction==='loadSettings'||cmd.pluginaction==='saveSettings')settingsReply({error:e.message});else if(cmd.pluginaction==='unlockVault'||cmd.pluginaction==='saveVault')vaultReply({error:e.message});else{jobs.delete(client);reply({error:e.message});}}
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
    overlay.innerHTML=`<form id="restic-form" style="background:white;color:black;padding:24px;max-width:520px;width:90%;max-height:90vh;overflow:auto;font:14px sans-serif"><h2>Настроить бекап S3</h2><p id="restic-node"></p><p><button type="button" id="restic-check">Проверить установку и планировщик</button></p><p id="restic-check-result" role="status">Статус не проверен.</p><label>Идентификатор точки <input name="user" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" style="width:100%"></label> <button type="button" id="restic-use-name">Использовать имя компьютера</button><br><br><label>Пароль шифрования Restic <input name="password" type="password" required autocomplete="new-password" style="width:100%"></label> <button type="button" id="restic-password-generate">Создать пароль</button><br><br><label>Адрес S3 <input name="endpoint" type="url" required placeholder="https://" style="width:100%"></label><br><label>Регион <input name="region" required style="width:100%"></label><br><label>Bucket <input name="bucket" required style="width:100%"></label><br><label>Префикс <input name="prefix" value="restic" style="width:100%"></label><br><label>Access key <input name="access" required style="width:100%"></label><br><label>Secret key <input name="secret" type="password" required autocomplete="new-password" style="width:100%"></label><br><br><label>Путь к базе на Windows <input name="source" required value="C:\\База розница\\1Cv8.1CD" style="width:100%"></label><br><br><label>Лимит загрузки, КБ/с <input name="limit" type="number" min="1" value="350"></label><br><label>Свободно на диске, ГБ <input name="free" type="number" min="1" value="40"></label><br><label>Хранить циклов <input name="full" type="number" min="1" value="3"></label><br><label>Инкрементных запусков <input name="incremental" type="number" min="0" value="6"></label><fieldset><legend>Vaultwarden</legend><label>Адрес <input value="https://vw.it.kzvs.pro/" readonly style="width:100%"></label><br><label>Пользователь <input value="sokol@kzvs.pro" readonly style="width:100%"></label><br><label>API client_id <input name="vaultClientId" style="width:100%"></label><br><label>API client_secret <input name="vaultClientSecret" type="password" autocomplete="off" style="width:100%"></label><br><label>Мастер-пароль <input name="vaultMaster" type="password" autocomplete="off" style="width:100%"></label><br><button type="button" id="restic-vault-unlock">Разблокировать Vaultwarden</button><p>Сессия действует 30 минут. Пароль точки сохраняется в Vets_Backup до установки. API key сохраняется кнопкой «Сохранить настройки» на сервере. Мастер-пароль не сохраняется.</p></fieldset><p>Кнопка сохранения запоминает настройки и пароли на сервере для вашей учётной записи администратора. Сохраните пароль отдельно для восстановления.</p><p id="restic-status" role="status"></p><button type="submit">Создать и установить</button> <button type="button" id="restic-save">Сохранить настройки</button> <button type="button" id="restic-close">Закрыть</button></form>`;
    document.body.appendChild(overlay);document.getElementById('restic-node').textContent='Компьютер: '+(n.name||n._id);var self=this;
    var form=document.getElementById('restic-form');form._resticDirty=false;form.addEventListener('input',function(){form._resticDirty=true;});
    document.getElementById('restic-use-name').onclick=function(){var value=self.transliterate(n.name||'');if(!value){self.status('Не удалось получить идентификатор из имени компьютера. Введите его вручную.');return;}if(form.elements.user.value&&!confirm('Заменить текущий идентификатор точки?'))return;form.elements.user.value=value;form._resticDirty=true;self.status('Проверьте идентификатор: одинаковые имена могут совпасть.');};
    document.getElementById('restic-password-generate').onclick=function(){if(form.elements.password.value&&!confirm('Заменить текущий пароль шифрования? Для существующего хранилища нужен прежний пароль.'))return;var bytes=new Uint8Array(32);crypto.getRandomValues(bytes);var raw='';for(var i=0;i<bytes.length;i++)raw+=String.fromCharCode(bytes[i]);form.elements.password.value=btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');form._resticDirty=true;self.status('Пароль создан. До подключения хранилища сохраните его самостоятельно.');};
    document.getElementById('restic-check').onclick=function(){self.check(n._id);};
    document.getElementById('restic-save').onclick=function(){self.send('saveSettings',{settings:self.readSettings(form)});self.status('Сохранение настроек…');};
    document.getElementById('restic-vault-unlock').onclick=function(){var master=form.elements.vaultMaster.value;if(!master){self.status('Введите мастер-пароль Vaultwarden.');return;}self.status('Разблокировка Vaultwarden…');self.send('unlockVault',{clientId:form.elements.vaultClientId.value,clientSecret:form.elements.vaultClientSecret.value,master:master});form.elements.vaultMaster.value='';};
    self.send('loadSettings');
    document.getElementById('restic-close').onclick=function(){if(self.busy){alert('Дождитесь завершения операции.');return;}overlay.remove();};
    form.onsubmit=function(e){e.preventDefault();if(self.busy)return;var f=e.target;var node=n._id;if(!confirm('Сохранить пароль в Vaultwarden и установить бекап на выбранном компьютере?'))return;self.busy=true;self.node=node;self.parts=[];self.status('Сохранение пароля точки в Vaultwarden…');self.timer=setTimeout(function(){self.fail('Сервер не ответил вовремя. Проверьте Vets_Backup перед повтором.');},120000);var config=self.readSettings(f);delete config.VaultClientId;delete config.VaultClientSecret;config.User=f.elements.user.value;config.StorageType='S3';self.pendingConfig=config;self.send('saveVault',{id:config.User,password:config.Password});};
   },
   settingNames:{S3Endpoint:'endpoint',S3Region:'region',S3Bucket:'bucket',S3Prefix:'prefix',S3AccessKeyId:'access',S3SecretAccessKey:'secret',Password:'password',SourcePath:'source',UploadLimitKbps:'limit',MinFreeHddGb:'free',RetentionFullCount:'full',RetentionIncrementalCount:'incremental',VaultClientId:'vaultClientId',VaultClientSecret:'vaultClientSecret'},
   vaultResult:function(m){if(m.error){if(this.busy)this.fail(m.error);else this.status('Vaultwarden: '+m.error);return;}if(m.unlocked){this.status('Vaultwarden разблокирован на 30 минут.');return;}if(m.saved&&this.busy&&this.pendingConfig){this.status('Пароль сохранён. Создание пакета…');var config=this.pendingConfig;this.pendingConfig=null;this.send('build',{config:config});}},
   transliterate:function(name){var map={'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'};var out='';for(var ch of name.toLowerCase()){if(Object.prototype.hasOwnProperty.call(map,ch))out+=map[ch];else if(/[a-z0-9._-]/.test(ch))out+=ch;else out+='-';}out=out.replace(/-+/g,'-').replace(/^[^a-z0-9]+|[.\-_]+$/g,'');if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(out))out='point-'+out;return out.slice(0,80).replace(/[.\-_]+$/g,'');},
   readSettings:function(form){var result={};for(var key in this.settingNames)result[key]=form.elements[this.settingNames[key]].value;return result;},
   settings:function(m){var form=document.getElementById('restic-form');if(!form)return;if(m.error){this.status('Ошибка настроек: '+m.error);return;}if(m.saved){this.status('Настройки сохранены.');return;}if(m.settings&&!form._resticDirty){for(var key in this.settingNames)if(typeof m.settings[key]==='string')form.elements[this.settingNames[key]].value=m.settings[key];}},
   check:function(node){
    var result=document.getElementById('restic-check-result');if(!result)return;result.textContent='Проверка…';
    var dir='C:/Windows/System32/config/systemprofile/AppData/Local/Temp',id=Array.from(crypto.getRandomValues(new Uint8Array(16)),function(x){return x.toString(16).padStart(2,'0');}).join(''),prefix='restic-check-'+id, marker=(dir+'/'+prefix).replace(/\//g,'\\');
    var script="$ErrorActionPreference='Stop';$m='"+marker+"';try{if(-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)){throw 'scheduler unavailable'};$dirs=@();if(Test-Path 'C:\\restic'){ $dirs+=Get-Item 'C:\\restic';$dirs+=Get-ChildItem 'C:\\restic' -Directory };$installed=0;$scheduled=0;foreach($d in $dirs){$c=Join-Path $d.FullName 'config.json';$b=Join-Path $d.FullName 'backup.ps1';$r=Join-Path $d.FullName 'restic.exe';if((Test-Path $c) -and (Test-Path $b) -and (Test-Path $r)){$v=Get-Content -LiteralPath $c -Raw -Encoding UTF8 | ConvertFrom-Json;if($v.User -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$'){throw 'invalid configuration'};$installed++;$t=Get-ScheduledTask -TaskName ('ResticBackup_'+$v.User) -ErrorAction SilentlyContinue;if($t -and $t.State -ne 'Disabled' -and @($t.Actions | Where-Object { $_.Arguments -like ('*'+$b+'*') }).Count -gt 0){$scheduled++}}};New-Item -ItemType File -Force -Path ($m+'-'+$installed+'-'+$scheduled+'.ok') | Out-Null}catch{New-Item -ItemType File -Force -Path ($m+'.failed') | Out-Null}";
    var encoded=btoa(unescape(encodeURIComponent(script)).split('').map(function(c){return c+'\0';}).join(''));
    var redirect,ended=false,interval,timer,start=Date.now();
    function finish(msg){if(ended)return;ended=true;clearInterval(interval);clearTimeout(timer);try{redirect.Stop();}catch(e){}var field=document.getElementById('restic-check-result');if(field)field.textContent=msg;}
    function query(){if(Date.now()-start>60000){finish('Не удалось получить результат проверки.');return;}try{redirect.sendText(JSON.stringify({action:'ls',reqid:42,path:dir}));}catch(e){finish('Файловое соединение прервано.');}}
    var protocol=CreateRemoteFiles(function(data){var m=data;try{if(typeof m==='string')m=JSON.parse(m);}catch(e){return;}if(!m||Number(m.reqid)!==42||!Array.isArray(m.dir))return;var hit=m.dir.find(function(x){return x.n===prefix+'.failed'||(x.n.indexOf(prefix+'-')===0&&/^-\d+-\d+\.ok$/.test(x.n.slice(prefix.length)));});if(!hit)return;try{redirect.sendText(JSON.stringify({action:'rm',reqid:43,path:dir,delfiles:[hit.n],rec:false}));}catch(e){}if(hit.n===prefix+'.failed'){finish('Ошибка проверки на компьютере. Проверьте права агента и доступность планировщика.');return;}var counts=hit.n.slice(prefix.length).match(/^-(\d+)-(\d+)\.ok$/),installed=Number(counts[1]),scheduled=Number(counts[2]);finish(installed===0?'Установка Restic не обнаружена.':'Установлено точек: '+installed+'. Включённых заданий с правильным скриптом: '+scheduled+'.');});
    redirect=CreateAgentRedirect(meshserver,protocol,serverPublicNamePort,authCookie,authRelayCookie,domainUrl);redirect.onStateChanged=function(x,state){if(state===3){clearTimeout(timer);meshserver.send({action:'runcommands',nodeids:[node],type:1,runAsUser:0,cmds:'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+encoded});query();interval=setInterval(query,3000);}else if(state===0&&!ended)finish('Не удалось подключить файловый канал.');};timer=setTimeout(function(){finish('Не удалось подключить файловый канал.');},30000);try{redirect.Start(node);}catch(e){finish('Не удалось начать проверку: '+e.message);}
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
 obj.onSettings=function(server,message){var m=message||server;if(window.ResticPlugin)window.ResticPlugin.settings(m);};
 obj.onVault=function(server,message){var m=message||server;if(window.ResticPlugin)window.ResticPlugin.vaultResult(m);};
 return obj;
};
module.exports.restic=module.exports;
