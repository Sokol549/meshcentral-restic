'use strict';
const fs=require('fs'),path=require('path');
const startup=require('./restic')({}).onWebUIStartupEnd.toString();
const html=`<!doctype html><meta charset="utf-8"><div id="devListToolbar"><button id="GroupActionButton">Group</button></div><div id="p10info"></div><script>
window.currentNode=null;
window.testNodes=[{_id:'a',name:'Аптека 1',conn:1},{_id:'b',name:'Аптека 2',conn:1}];
window.getCheckedDevices=()=>['a','b'];
window.getNodeFromId=id=>testNodes.find(n=>n._id===id);
window.meshserver={send:m=>{window.messages.push(m);if(m.pluginaction==='loadSettings')setTimeout(()=>ResticPlugin.settings({settings:{S3Endpoint:'https://hb.ru-msk.vkcloud-storage.ru',S3Region:'ru-msk',S3Bucket:'vets',S3AccessKeyId:'x',S3SecretAccessKey:'x'}}),0);}};
window.messages=[];window.confirm=()=>true;
(${startup})();
ResticPlugin.findSource=(id,cb)=>cb({paths:id==='a'?['C:\\\\База Розница\\\\1Cv8.1CD']:['C:\\\\Other\\\\1Cv8.1CD'],skipped:0,incomplete:false},'ok');
</script>`;
const destination=process.argv[2];if(!destination)throw Error('Destination required');fs.writeFileSync(path.resolve(destination),html);
