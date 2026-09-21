import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'dist');
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const routes=[['home','/'],['songs','/songs/'],['song-numeric','/songs/10000036/'],['song-special','/songs/id-74-69-74-6c-65-3a-67-6c-69-74-74-65-72-73-63-61-74-74-65-72/'],['jubility','/jubility/'],['unlock','/unlock/'],['gameplay','/gameplay/'],['about','/about/']];
const viewports=[['375',375,812],['768',768,1024],['1440',1440,960]];
const stamp=new Date().toISOString();
const mode=process.argv[2]||'all';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function runChrome(args,timeout=18000){return new Promise((resolve,reject)=>{const p=spawn(chrome,args,{stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('chrome timeout'))},timeout);p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',e=>{clearTimeout(timer);reject(e)});p.on('close',(code,signal)=>{clearTimeout(timer);code===0?resolve({out,err}):reject(Error(`chrome exit ${code} ${signal||''}: ${err}`))})})}
function urlFor(port,u){return `http://127.0.0.1:${port}${u}`}
async function main(){
 const server=createServer(async(req,res)=>{let f=path.join(dist,decodeURIComponent(new URL(req.url,'http://x').pathname));if(f.endsWith('/'))f+='index.html';try{const body=await readFile(f);res.writeHead(200);res.end(body)}catch{if(!res.headersSent)res.writeHead(404);res.end('not found')}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
 await mkdir(path.join(root,'docs','browser-audit'),{recursive:true}); const records=[],assertions=[];
 try {
  if(mode==='all'||mode==='responsive') for(const [name,u] of routes) for(const [vn,w,h] of viewports){
   const target=urlFor(port,u); const shot=path.join(root,'docs','browser-audit',`${name}-${vn}-t21.png`);
   await runChrome(['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',`--window-size=${w},${h}`,`--screenshot=${shot}`,target]);
   records.push({routeName:name,url:u,viewport:{name:vn,width:w,height:h},screenshot:path.relative(root,shot),browserCommand:'chrome --headless=new --screenshot',pass:true});
  }
  if(mode==='all'||mode==='nojs'){
   const {out}=await runChrome(['--headless=new','--disable-gpu','--no-sandbox','--disable-javascript','--dump-dom','--window-size=375,812',urlFor(port,'/')]);
   const required=['曲目库','数据','图鉴','关于']; const ok=required.every(x=>out.includes(x))&&out.includes('nav-toggle');
   assertions.push({name:'375px 禁 JS 一级导航静态可见',pass:ok,details:'Chrome --disable-javascript --dump-dom'}); if(!ok)throw Error('no-JS navigation missing');
  }
  const out={round:'t21-cli',generatedAt:stamp,mode,records,assertions,lifecycle:{method:'Chrome CLI short-lived processes',noWebSocketHandles:true,serverClosed:false}};
  await writeFile(path.join(root,'docs','browser-audit-evidence.json'),JSON.stringify(out,null,2));
  console.log(`${mode}: ${records.length} records / ${assertions.length} assertions passed`);
 } finally {await new Promise(r=>server.close(r))}
}
try{await main();process.exitCode=0}catch(e){console.error(e.stack||e);process.exitCode=1}
