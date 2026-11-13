import { chromium } from 'playwright';
let rendering=false;
export async function renderWordpressProduction(snapshot){
 if(rendering)throw new Error('production_renderer_busy');
 if(!snapshot||!Number.isInteger(snapshot.wordpressId)||snapshot.wordpressId<1||!Array.isArray(snapshot.nodes)||snapshot.nodes.length>200)throw new Error('invalid_production_snapshot');
 if(!(snapshot.width>0&&snapshot.width<=5000&&snapshot.height>0&&snapshot.height<=5000))throw new Error('invalid_stage_dimensions');
 for(const n of snapshot.nodes){if(n.source){const u=new URL(n.source);if(u.protocol!=='https:'||u.hostname!=='wearhongxiu.com'||!u.pathname.startsWith('/wp-content/uploads/'))throw new Error('invalid_snapshot_asset');}}
 rendering=true;let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  await page.goto(`https://wearhongxiu.com/pod-designer/?product_id=${snapshot.wordpressId}&production_render=1`,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>!!document.querySelector('[data-hxpd]')?.hxpdRestoreSnapshot&&!!window.hxpdServerExport&&!!document.querySelector('[data-hxpd]')?.hxpdManifest,null,{timeout:60000});
  const result=await page.evaluate(async snapshot=>{
   const root=document.querySelector('[data-hxpd]');await root.hxpdRestoreSnapshot(snapshot);
   return await window.hxpdServerExport(root);
  },snapshot);
  return result;
 }finally{if(browser)await browser.close();rendering=false;}
}
