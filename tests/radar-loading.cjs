const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('frontend/app.js','utf8');
const begin = src.indexOf('let radarLoadGeneration');
const end = src.indexOf('// 未解析曲数に応じて',begin);
const hud = {textContent:''};
let requests=[], recommend=[], painted=[], orders=[];
const defer=()=>{let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const ctx=vm.createContext({
 document:{getElementById:()=>hud},console,
 tunedropFetch:()=>{const d=defer();requests.push(d);return d.promise;},
 fetchRadarRecommend:()=>{const d=defer();recommend.push(d);return d.promise;},
 spreadLegacyRadarMap:d=>d,
 applyRadarOrder:(order)=>orders.push(order),
 applyRadarFilter:()=>painted.push(vm.runInContext('vibeMapData.map(p=>p.youtube_id).join(",")',ctx)),
 buildRadarVibeOptions(){},buildRadarTempoOptions(){},radarDataSig(){return 'sig';},updateRadarAnalyzeButton(){},
});
vm.runInContext('let vibeMapData=[], radarRecommendTaste="", radarPendingCount=0, radarLastTotal=0, radarStripLimit=0, radarOptionsSig="";'+src.slice(begin,end).replace(/^export /gm,''),ctx);
const response=id=>({json:async()=>({success:true,count:1,method:'umap',points:[{youtube_id:id,features:{}}]})});
(async()=>{
 const first=ctx.loadRadarData();requests[0].resolve(response('first'));await first;
 assert.deepEqual(painted,['first'],'おすすめ未完了でもマップを描画');
 const slow=ctx.loadRadarData(),fast=ctx.loadRadarData();
 requests[2].resolve(response('new'));await fast;
 requests[1].resolve(response('stale'));await slow;
 assert.deepEqual(painted,['first','new'],'遅れた応答が最新マップを上書きしない');
 recommend[0].resolve({order:['first']});recommend[1].resolve({order:['stale']});
 recommend[2].resolve({order:['new'],taste:'新しいおすすめ'});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(orders,[['new']]);
 assert(hud.textContent.includes('新しいおすすめ'));
 const failure=ctx.loadRadarData();requests[3].resolve({json:async()=>({error:'接続エラー'})});await failure;
 assert.equal(painted.at(-1),'new');
 assert.equal(hud.textContent,'接続エラー');
 const pollStart=src.indexOf('export async function pollAnalyzeStatus');
 const pollEnd=src.indexOf('export function renderRadarLegend',pollStart);
 vm.runInContext(src.slice(pollStart,pollEnd).replace(/^export /gm,''),ctx);
 ctx.tunedropFetch=async()=>({json:async()=>({state:{running:false,interrupted:true,results:[]}})});
 await ctx.pollAnalyzeStatus(null);
 assert(hud.textContent.includes('中断'));
 ctx.tunedropFetch=async()=>{throw new Error('offline');};
 await ctx.pollAnalyzeStatus(null);
 assert(hud.textContent.includes('取得できません'));
 console.log('PASS: immediate rendering, stale responses, recommendations, retained map, interrupted/offline analysis status');
})().catch(e=>{console.error(e);process.exitCode=1;});
