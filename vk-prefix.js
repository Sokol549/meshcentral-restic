'use strict';
const crypto=require('crypto'),https=require('https'),fs=require('fs'),path=require('path');
const hash=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const mac=(k,s)=>crypto.createHmac('sha256',k).update(s,'utf8').digest();
const encode=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
function makeRequest(c,now=new Date()){
 const url=new URL(c.S3Endpoint);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||!/^(?:hb|hb\.[a-z0-9-]+)\.vkcloud-storage\.ru$/.test(url.hostname)||url.port)throw Error('Укажите HTTPS endpoint VK Cloud Object Storage');
 if(!/^[a-z0-9][a-z0-9._-]{0,66}$/.test(c.User)||c.User.endsWith('.')||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(c.User))throw Error('Идентификатор должен содержать строчные латинские буквы, цифры, точку, дефис или подчёркивание');
 if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.S3Bucket)||/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(c.S3Bucket)||!/^[a-z0-9-]+$/.test(c.S3Region)||!c.S3AccessKeyId||!c.S3SecretAccessKey)throw Error('Проверьте бакет, регион и управляющие ключи VK');
 const prefix=String(c.S3Prefix||'').replace(/^\/+|\/+$/g,'');if(/[\\?#\x00-\x20]/.test(prefix)||prefix.split('/').some(x=>x==='.'||x==='..'))throw Error('Недопустимый префикс');
 const scoped=(prefix?prefix+'/':'')+c.User+'/',username='restic-'+c.User,host=c.S3Bucket+'.'+url.host;
 const query='pak=&prefix='+encode(scoped)+'&username='+encode(username),stamp=now.toISOString().replace(/[:-]|\.\d{3}/g,''),date=stamp.slice(0,8),empty=hash('');
 const headers='host:'+host+'\nx-amz-content-sha256:'+empty+'\nx-amz-date:'+stamp+'\n',signed='host;x-amz-content-sha256;x-amz-date',scope=date+'/'+c.S3Region+'/s3/aws4_request';
 const canonical='PUT\n/\n'+query+'\n'+headers+'\n'+signed+'\n'+empty,stringToSign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hash(canonical);
 const signing=mac(mac(mac(mac(Buffer.from('AWS4'+c.S3SecretAccessKey),date),c.S3Region),'s3'),'aws4_request'),signature=mac(signing,stringToSign).toString('hex');
 return {url:'https://'+host+'/?'+query,username,scoped,headers:{'x-amz-content-sha256':empty,'x-amz-date':stamp,Authorization:'AWS4-HMAC-SHA256 Credential='+c.S3AccessKeyId+'/'+scope+', SignedHeaders='+signed+', Signature='+signature}};
}
function request(req){return new Promise((resolve,reject)=>{const q=https.request(req.url,{method:'PUT',headers:req.headers,timeout:30000},r=>{let data='';r.setEncoding('utf8');r.on('data',x=>{data+=x;if(data.length>65536)q.destroy();});r.on('end',()=>r.statusCode>=200&&r.statusCode<300?resolve(data):reject(Error('VK Cloud отклонил создание ключа (HTTP '+r.statusCode+'); проверьте ключи и состояние VK перед повтором')));});q.on('timeout',()=>q.destroy());q.on('error',()=>reject(Error('Результат запроса VK Cloud неизвестен: перед повтором проверьте созданный ключ')));q.end();});}
function readTag(xml,tag){const m=xml.match(new RegExp('<(?:[A-Za-z0-9_-]+:)?'+tag+'>([^<]+)</(?:[A-Za-z0-9_-]+:)?'+tag+'>'));return m?m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"):'';}
function failureDetail(error){
 const message=String(error&&error.message||'');
 const http=/^VK Cloud отклонил создание ключа \(HTTP (\d{3})\);/.exec(message);
 if(http)return {kind:'http',status:Number(http[1])};
 if(message==='Результат запроса VK Cloud неизвестен: перед повтором проверьте созданный ключ')return {kind:'network'};
 if(message==='Ответ VK Cloud не подтверждает ожидаемый бакет или префикс; проверьте ключ в VK Cloud')return {kind:'response'};
 return {kind:'unknown'};
}
function describePending(lock){
 let saved;try{saved=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{return '';}
 const d=saved&&saved.failure;
 if(!d||typeof d!=='object')return '';
 if(d.kind==='http'&&Number.isInteger(d.status)&&d.status>=100&&d.status<=599)return ' Первоначальный ответ VK Cloud: HTTP '+d.status+'.';
 if(d.kind==='network')return ' Первоначальная ошибка: ответ VK Cloud не получен.';
 if(d.kind==='response')return ' Первоначальная ошибка: ответ VK Cloud не подтвердил параметры ключа.';
 if(d.kind==='unknown')return ' Первоначальная ошибка не определена.';
 return '';
}
function inspectPending(c,root){
 const req=makeRequest(c),dir=path.join(root,'restic-vk-keys');
 const id=hash(JSON.stringify([new URL(c.S3Endpoint).origin,c.S3Region,c.S3Bucket,req.scoped]));
 const lock=path.join(dir,id+'.pending'),file=path.join(dir,id+'.json');
 let stat;try{stat=fs.lstatSync(lock);}catch(e){if(e.code==='ENOENT')return {pending:false};throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Некорректная отметка операции');
 const data=JSON.parse(fs.readFileSync(lock,'utf8'));
 return {pending:true,identityMatches:data.username===req.username&&data.prefix===req.scoped,
  createdAt:stat.birthtime.toISOString(),modifiedAt:stat.mtime.toISOString(),
  savedCredentialExists:fs.existsSync(file),detail:describePending(lock)};
}
async function provision(c,root,send=request){
 const req=makeRequest(c),dir=path.join(root,'restic-vk-keys');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
 const id=hash(JSON.stringify([new URL(c.S3Endpoint).origin,c.S3Region,c.S3Bucket,req.scoped])),file=path.join(dir,id+'.json'),lock=path.join(dir,id+'.pending');
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.bucket!==c.S3Bucket||saved.adminIdHash!==hash(c.S3AccessKeyId)||saved.prefix!==req.scoped||saved.username!==req.username||!saved.accessKey||!saved.secretKey)throw Error('Invalid saved key');return saved;}catch(e){if(e.code!=='ENOENT')throw Error('Невозможно прочитать сохранённый ключ аптеки');}
 try{fs.writeFileSync(lock,JSON.stringify({username:req.username,prefix:req.scoped}),{mode:0o600,flag:'wx'});}catch(e){if(e.code==='EEXIST')throw Error('Предыдущая попытка создания ключа не завершена: проверьте VK Cloud и состояние на сервере перед повтором.'+describePending(lock));throw e;}
 let saved;try{const xml=await send(req);saved={adminIdHash:hash(c.S3AccessKeyId),bucket:readTag(xml,'BucketName'),username:readTag(xml,'UserName'),prefix:readTag(xml,'Prefix'),accessKey:readTag(xml,'AccessKey'),secretKey:readTag(xml,'SecretKey')};if(saved.bucket!==c.S3Bucket||saved.username!==req.username||saved.prefix!==req.scoped||!saved.accessKey||!saved.secretKey)throw Error('Ответ VK Cloud не подтверждает ожидаемый бакет или префикс; проверьте ключ в VK Cloud');fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600,flag:'wx'});}catch(e){try{fs.writeFileSync(lock,JSON.stringify({username:req.username,prefix:req.scoped,failure:failureDetail(e)}),{mode:0o600});}catch(ignore){}throw e;}fs.unlinkSync(lock);return saved;
}
module.exports={makeRequest,provision,inspectPending};
