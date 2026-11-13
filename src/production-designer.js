// Playwright page APIs only. No CDP attachment or local Chrome dependency.
export async function attachStore(page) {
  await page.waitForFunction(() => {
    for(const el of document.querySelectorAll('*')) {
      const key=Object.keys(el).find(k=>k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance'));
      if(!key)continue;
      for(let f=el[key],n=0;f&&n<14;f=f.return,n++){
        const s=f.memoizedProps?.store;
        if(s?.data?.layers&&s.canvasRef){window.__productionStore=s;return true;}
      }
    }
    return false;
  },null,{timeout:60000});
}
export async function selectProductionTemplate(page, plan) {
  await attachStore(page);
  const name=plan.mode.templateName;
  const groups=page.locator('[class*="groupItem"] [class*="name__style"]');
  if(await groups.count()) {
    if(!name)throw new Error('exact_template_name_missing');
    const labels=await groups.allTextContents();const index=labels.findIndex(s=>s.trim()===name.trim());
    if(index<0)throw new Error('exact_template_not_found');
    await groups.nth(index).click();
  }
  await attachStore(page);
  await page.waitForFunction(ids=>{
    const actual=window.__productionStore.data.layers.filter(l=>l.pageType==='normal').map(l=>String(l.id));
    return actual.length===ids.length&&ids.every(id=>actual.includes(id));
  },plan.sides.map(s=>s.sourceSideId),{timeout:30000});
}
export async function uploadProductionSide(page, side, buffer, fileName, placement) {
  const index=await page.evaluate(id=>window.__productionStore.data.layers.filter(l=>l.pageType==='normal').findIndex(l=>String(l.id)===id),side.sourceSideId);
  if(index<0)throw new Error('source_side_not_found');
  await page.locator('[class*="faces__style"] [class*="itemBox__style"] [class*="item__style"]').nth(index).click();
  await page.waitForFunction(id=>String(window.__productionStore.activeLayerId)===id,side.sourceSideId);
  const before=await page.evaluate(()=>window.__productionStore.canvasRef.canvas.getObjects().length);
  if(before!==0)throw new Error('production_target_not_empty');
  await page.getByText('上传',{exact:true}).first().click();
  await page.locator('input[type=file]').first().waitFor({state:'attached'});
  await page.evaluate(async ({base64,name,mime})=>{
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],name,{type:mime}));
    const input=document.querySelector('input[type=file]');input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  },{base64:buffer.toString('base64'),name:fileName,mime:side.mime||'image/png'});
  await page.waitForFunction(()=>window.__productionStore.canvasRef.canvas.getObjects().filter(o=>o.type==='image').length===1,null,{timeout:180000});
  const geometry=await page.evaluate(id=>{
    const s=window.__productionStore,c=s.canvasRef,l=s.data.layers.find(l=>String(l.id)===id),o=c.canvas.getObjects().find(o=>o.type==='image');
    const p=s.previewRef;let rect;
    for(const key of ['getDesignLayerCorpSize','getDesignSideCorpSize'])if(typeof p?.[key]==='function'){try{rect=p[key](l);if(rect?.width>0)break}catch{}}
    if(!rect?.width)throw Error('official_crop_unavailable');
    const url=new URL(o.sds?.originUrl||o.getSrc());
    return {rect,width:o.width,height:o.height,thumbsZoom:Number(url.searchParams.get('thumbsZoom')||1),materialId:url.searchParams.get('material_id')};
  },side.sourceSideId);
  if(!geometry.materialId||Math.abs(geometry.width*geometry.thumbsZoom-side.width)>2||Math.abs(geometry.height*geometry.thumbsZoom-side.height)>2)throw new Error('uploaded_png_dimensions_changed');
  const transform=placement(geometry.rect,geometry.width,geometry.height);
  const verified=await page.evaluate(({id,t})=>{
    const s=window.__productionStore,c=s.canvasRef;if(String(s.activeLayerId)!==id)throw Error('active_side_changed');
    const objects=c.canvas.getObjects();if(objects.length!==1)throw Error('unexpected_layer_count');
    const o=objects[0];o.set(t);o.setCoords();c.canvas.requestRenderAll();c.addHistory();c.updateEditor();
    return {sideId:id,left:o.left,top:o.top,scaleX:o.scaleX,scaleY:o.scaleY,width:o.width,height:o.height};
  },{id:side.sourceSideId,t:transform});
  for(const key of ['left','top','scaleX','scaleY'])if(Math.abs(verified[key]-transform[key])>1e-6)throw new Error('placement_readback_mismatch');
  return {verified,rect:geometry.rect};
}
