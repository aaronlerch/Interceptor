#!/usr/bin/env bun
/**
 * scripts/ios-web-demo.ts — live end-to-end demo of the ios web lane. Waits for a
 * live Safari page, navigates it to a real content site, and extracts + interacts.
 */
import { IosWebManager } from "../daemon/ios/web-manager"
import { usbmuxListDevices } from "../daemon/ios/usbmux-forward"

const udid = (await usbmuxListDevices())[0].udid
const ctx = `ios:${udid}`
const mgr = new IosWebManager({})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function apps(): Promise<any[]> {
  const r = await mgr.handle({ type: "ios_web_targets" }, ctx)
  return (r.data as any)?.applications ?? []
}
async function attachFirstPage(): Promise<string | undefined> {
  const tg = (await apps()).flatMap((a) => a.targets).find((t: any) => t.type === "web-page")
  if (!tg) return undefined
  await mgr.handle({ type: "ios_web_attach", targetId: tg.targetId, replace: true }, ctx)
  return tg.url
}
async function evalJs(expr: string): Promise<any> {
  const r = await mgr.handle({ type: "ios_web_eval", expression: expr }, ctx)
  if (!r.success) return { __err: (r.data as any)?.code ?? r.error }
  return (r.data as any)?.result?.result?.value
}
/** Attach to whatever page is live and confirm it actually answers. */
async function waitForLivePage(label: string, match?: (t: string) => boolean, tries = 20): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    await attachFirstPage()
    const title = await evalJs("document.title")
    if (typeof title === "string" && (!match || match(title))) return title
    if (i === 0) console.log(`  waiting for ${label}… (foreground Safari & keep it awake)`)
    await sleep(3000)
  }
  return undefined
}

console.log("① Watching for a live Safari page (foreground Safari on any real page)…")
const t0 = await waitForLivePage("a live page", undefined, 120)
if (!t0) { console.log("✗ no live inspectable page after 60s — unlock the phone and foreground Safari."); process.exit(1) }
console.log(`  ✓ live: "${t0}" @ ${await evalJs("location.href")}`)

console.log("\n② Navigating Safari → Hacker News (news.ycombinator.com)…")
await evalJs("location.href='https://news.ycombinator.com/'")
await sleep(2500)
const t1 = await waitForLivePage("Hacker News", (t) => /hacker news/i.test(t))
if (!t1) { console.log("  (navigation dropped the session and the new page didn't come back live — keep Safari foreground)"); process.exit(1) }
console.log(`  ✓ now on: "${t1}"`)

console.log("\n③ Extracting the top stories (structured data from the live DOM):")
const stories = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('tr.athing')].slice(0,10).map(function(row){
  var t=row.querySelector('.titleline a'); var sub=row.nextElementSibling;
  var score=sub&&sub.querySelector('.score'); var by=sub&&sub.querySelector('.hnuser');
  var cmt=sub&&[...sub.querySelectorAll('a')].pop();
  return {rank:(row.querySelector('.rank')||{}).innerText, title:t&&t.innerText, host:(row.querySelector('.sitestr')||{}).innerText||'', points:score?score.innerText:'', by:by?by.innerText:'', comments:cmt?cmt.innerText:''};
}))`) || "[]")
for (const s of stories) console.log(`  ${String(s.rank).padStart(3)} ${s.title}  [${s.host}]  — ${s.points||'0 points'}, ${s.comments||'no comments'}${s.by?` by ${s.by}`:''}`)

console.log(`\n④ Page facts via live eval:`)
console.log("  ", await evalJs(`document.querySelectorAll('a').length + ' links, ' + document.querySelectorAll('tr.athing').length + ' stories, viewport ' + innerWidth + 'x' + innerHeight + ', UA=' + navigator.userAgent.slice(0,60)`))

console.log(`\n⑤ Interact — click the #1 story's comments link via the DOM lane, read where it goes:`)
const before = await evalJs("location.href")
await evalJs(`(function(){var s=document.querySelector('tr.athing');var sub=s.nextElementSibling;var c=[...sub.querySelectorAll('a')].find(a=>/comment/.test(a.textContent)||/item\\?id/.test(a.href));if(c){c.click();return 'clicked '+c.href}return 'no comments link'})()`)
await sleep(2500)
const t2 = await waitForLivePage("comments page", (t) => t !== t1, 8)
console.log(`  from ${before}\n  →   ${await evalJs("location.href")}  ("${t2 ?? await evalJs('document.title')}")`)
if (/item/.test(String(await evalJs("location.href")))) {
  console.log(`  top comment: "${String(await evalJs(`(document.querySelector('.commtext')||{innerText:'(none yet)'}).innerText`)).slice(0,180)}"`)
}

await mgr.handle({ type: "ios_web_detach" }, ctx)
console.log("\n✓ demo complete — detached cleanly.")
process.exit(0)
