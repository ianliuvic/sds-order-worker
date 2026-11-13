import fs from 'node:fs';
const productionSizes=JSON.parse(fs.readFileSync(new URL('./production-sizes.json',import.meta.url),'utf8'));
export function productionPlan(intake, manifest) {
  const mode = manifest?.modes?.find(m => m.kind === intake.modeKind && (!intake.meta?.prototypeGroupId || String(m.prototypeGroupId) === String(intake.meta.prototypeGroupId)));
  if (!mode) throw new Error('production_template_not_found');
  if (!manifest.designProductId) throw new Error('design_product_id_missing');
  const expected = mode.sides || [], supplied = intake.sides || [];
  if (!expected.length || expected.length !== supplied.length || new Set(supplied.map(s => String(s.sideId))).size !== expected.length) throw new Error('production_sides_incomplete');
  const sides = expected.map(side => {
    const designSize=side.designSize||productionSizes[`${intake.productId}:${mode.kind}:${side.id}`];
    const file = supplied.find(s => String(s.sideId) === String(side.id));
    if (!file || !(file.width > 0 && file.height > 0)) throw new Error('production_side_missing_or_invalid:' + side.id);
    if (intake.source === 'wordpress_inquiry' && (file.mime !== 'image/png' || file.width !== designSize?.width || file.height !== designSize?.height)) throw new Error('production_png_size_mismatch:' + side.id);
    if (Math.abs(file.width / file.height - side.previewWidth / side.previewHeight) > .005) throw new Error('production_side_aspect_mismatch:' + side.id);
    return {...file, sourceSideId: String(side.sourceSideId || side.id), previewWidth: side.previewWidth, previewHeight: side.previewHeight};
  });
  return {mode, sides, designProductId: String(manifest.designProductId)};
}

export function cartLines(intake) {
  const rows = intake.source === 'wordpress_inquiry' ? intake.meta?.sizes : intake.orders;
  if (!Array.isArray(rows) || !rows.length) throw new Error('production_sizes_missing');
  const totals = new Map();
  for (const row of rows) {
    const size = String(row.size || '').trim(), quantity = Number(row.quantity);
    if (!size || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('production_size_quantity_invalid');
    totals.set(size, (totals.get(size) || 0) + quantity);
  }
  return [...totals].map(([size,quantity]) => ({size,quantity}));
}

export function placement(rect, width, height) {
  if (![rect.left,rect.top,rect.width,rect.height,width,height].every(Number.isFinite) || Math.min(rect.width,rect.height,width,height) <= 0) throw new Error('production_crop_invalid');
  return {left:rect.left+rect.width/2,top:rect.top+rect.height/2,originX:'center',originY:'center',scaleX:rect.width/width,scaleY:rect.height/height,angle:0,flipX:false,flipY:false};
}
