'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const base = __dirname;
const files = ['restic-manager.ps1','backup.ps1','deploy-restic.ps1','restic-storage.ps1','restic-settings.ps1','restic-mail.ps1','restic.exe'];
const table = Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++) n=(n&1)?(0xedb88320^(n>>>1)):(n>>>1);return n>>>0;});
function crc32(data){let c=0xffffffff; for(const b of data)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function zip(entries){let offset=0, locals=[], central=[]; for(const [name,data] of entries){const filename=Buffer.from(name);const compressed=zlib.deflateRawSync(data);const crc=crc32(data);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(filename.length,26);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);locals.push(h,filename,compressed);central.push(c,filename);offset+=h.length+filename.length+compressed.length;}const cd=Buffer.concat(central), end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);}
function validate(config){
 if(!config || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.User||'') || /\.$/.test(config.User) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(config.User)) throw Error('Invalid user');
 if(typeof config.Password!=='string'||!config.Password.trim()||typeof config.SourcePath!=='string'||!config.SourcePath.trim()) throw Error('Password and source path are required');
 if(config.StorageType!=='S3') throw Error('Only S3 storage is supported');
 let url;try{url=new URL(config.S3Endpoint);}catch{throw Error('Invalid server URL');} if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw Error('Invalid server URL');
 if(config.StorageType==='S3') { if(url.protocol!=='https:'||url.pathname!=='/'||!(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.S3Bucket||''))||/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(config.S3Bucket)||!(/^[a-z0-9-]+$/.test(config.S3Region||''))||!config.S3AccessKeyId||!config.S3SecretAccessKey||/[\\?#\x00-\x20]/.test(config.S3Prefix||'')||String(config.S3Prefix||'').split('/').some(x=>x==='.'||x==='..')) throw Error('Invalid S3 settings'); }
 const num=(v,d,min,max)=>{if(v===undefined||v==='')return d;const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw Error('Invalid numeric setting');return n;};
 const enabled=config.MailEnabled==='true',ssl=config.MailUseSsl!=='false';let mail={Enabled:false};
 if(enabled){const address=s=>typeof s==='string'&&s.length<=254&&!/[\r\n\s]/.test(s)&&/^[^@]+@[^@]+\.[^@]+$/.test(s);if(!/^(?=.{1,253}$)[a-zA-Z0-9.-]+$/.test(config.MailServer||'')||!address(config.MailFrom)||!address(config.MailTo)||typeof config.MailUsername!=='string'||typeof config.MailPassword!=='string')throw Error('Проверьте настройки SMTP и адреса отправителя и получателя');mail={Enabled:true,Server:config.MailServer,Port:num(config.MailPort,587,1,65535),UseSsl:ssl,Username:config.MailUsername,Password:config.MailPassword,From:config.MailFrom,To:config.MailTo,TimeoutSeconds:15};}
 const payload={StorageType:config.StorageType,User:config.User,Password:config.Password,SourcePath:config.SourcePath,UploadLimitKbps:num(config.UploadLimitKbps,350,1,100000000),MinFreeHddGb:num(config.MinFreeHddGb,40,1,1000000),UploadLimitMode:'Manual',UploadLimitPercent:50,SpeedTestSeconds:20,SpeedTestMaxMiB:128,Mail:mail,RetentionMode:'Cycles',RetentionFullCount:num(config.RetentionFullCount,3,1,100000),RetentionIncrementalCount:num(config.RetentionIncrementalCount,6,0,100000)};
 Object.assign(payload,{S3Provider:'Generic',S3Endpoint:config.S3Endpoint,S3Region:config.S3Region,S3Bucket:config.S3Bucket,S3Prefix:config.S3Prefix||'',S3AccessKeyId:config.S3AccessKeyId,S3SecretAccessKey:config.S3SecretAccessKey});
 return payload;
}
function build(config){
 const payload=validate(config);
 const entries=files.map(name=>[name,fs.readFileSync(path.join(base,'assets',name))]);entries.push(['config.json',Buffer.from(JSON.stringify(payload))]);const archive=zip(entries), size=Buffer.alloc(8);size.writeBigInt64LE(BigInt(archive.length));return Buffer.concat([fs.readFileSync(path.join(base,'launcher.exe')),archive,size]);
}
module.exports={build,validate};
