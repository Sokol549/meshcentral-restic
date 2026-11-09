'use strict';
const assert=require('assert');let sent=[],form={elements:{user:{value:'point'},password:{value:''}}},status={textContent:''};global.window={};global.document={head:{appendChild(){}},createElement:()=>({}),getElementById:id=>id==='restic-form'?form:id==='restic-status'?status:null};global.meshserver={send:m=>sent.push(m)};global.confirm=()=>true;
require('./restic')({}).onWebUIStartupEnd();const p=window.ResticPlugin;
function start(){p.lookupVault(form,form.elements.user.value);return sent.pop()}
let q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,found:true,password:'existing-pass'});assert.equal(form.elements.password.value,'existing-pass');
form.elements.password.value='';q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,found:false});const generated=form.elements.password.value;assert.match(generated,/^[A-Za-z0-9_-]{43}$/);assert.equal(form._passwordPoint.id,'point');
form.elements.password.value='';q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,error:'locked'});assert.equal(form.elements.password.value,'');
q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId});assert.equal(form.elements.password.value,'');
q=start();form.elements.user.value='other';p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,found:false});assert.equal(form.elements.password.value,'');
form.elements.user.value='point';q=start();form.elements.password.value='manually-entered';p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,found:true,password:'old'});assert.equal(form.elements.password.value,'manually-entered');
let submissions=0;form.requestSubmit=()=>submissions++;form.elements.password.value='';form._installAfterLookup=true;q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,found:false});assert.equal(submissions,1);assert.equal(form._installAfterLookup,false);assert.match(form.elements.password.value,/^[A-Za-z0-9_-]{43}$/);
form.elements.password.value='';form._installAfterLookup=true;q=start();p.vaultResult({lookup:true,id:q.id,requestId:q.requestId,error:'locked'});assert.equal(submissions,1);assert.equal(form._installAfterLookup,false);assert.equal(form.elements.password.value,'');
console.log('Vault lookup: existing password, new secure password, errors and stale responses: OK');
