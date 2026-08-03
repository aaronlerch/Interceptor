import { IosWebManager } from "../daemon/ios/web-manager"
import { usbmuxListDevices } from "../daemon/ios/usbmux-forward"
const udid = (await usbmuxListDevices())[0].udid, ctx = `ios:${udid}`
const mgr = new IosWebManager({})
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms))
const BIG = `JSON.stringify({title:document.title,url:location.href,stories:document.querySelectorAll('tr.athing').length,links:document.querySelectorAll('a').length,vp:innerWidth+'x'+innerHeight,items:[...document.querySelectorAll('tr.athing')].slice(0,10).map(function(r){var t=r.querySelector('.titleline a');var s=r.nextElementSibling;var sc=s&&s.querySelector('.score');var by=s&&s.querySelector('.hnuser');var ls=s?[...s.querySelectorAll('a')]:[];var cm=ls.length?ls[ls.length-1]:null;return{rank:((r.querySelector('.rank')||{}).innerText||'').replace('.',''),title:t?t.innerText:'',host:(r.querySelector('.sitestr')||{}).innerText||'self',pts:sc?sc.innerText:'0 points',by:by?by.innerText:'',cm:cm?cm.innerText:''}})})`
async function grab(){
  for(let i=0;i<1000;i++){
    const tg=(await mgr.handle({type:"ios_web_targets"},ctx).then(r=>((r.data as any)?.applications??[]).flatMap((a:any)=>a.targets).find((t:any)=>t.type==="web-page")).catch(()=>null))
    if(tg){await mgr.handle({type:"ios_web_attach",targetId:tg.targetId,replace:true},ctx).catch(()=>{})
      const r=await mgr.handle({type:"ios_web_eval",expression:BIG},ctx)
      if(r.success){const v=(r.data as any).result?.result?.value; if(v) return JSON.parse(v)}
    }
    if(i===0)console.log("  hammering… keep the phone screen awake (tap it)")
    await sleep(1500)
  }
  return null
}
const d=await grab()
if(!d){console.log("✗ never caught a live window — the phone kept sleeping.");process.exit(1)}
console.log(`\n📱 LIVE from the phone's Safari — "${d.title}" (${d.url})`)
console.log(`   ${d.stories} stories · ${d.links} links · viewport ${d.vp}\n`)
console.log("═══ TOP 10 ON HACKER NEWS (scraped off the device DOM right now) ═══")
for(const s of d.items){console.log(` ${String(s.rank).padStart(2)}. ${s.title}  [${s.host}]`); console.log(`      ${s.pts} · ${s.cm} · by ${s.by||'—'}`)}
process.exit(0)
