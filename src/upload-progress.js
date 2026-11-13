export async function beginUploadProgress(page, sideId) {
  await page.evaluate(sideId => {
    if (!window.__productionUploadHook) {
      const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        const u = new URL(url, location.href);
        this.__productionUploadKind = method.toUpperCase() === 'POST'
          ? (u.hostname.endsWith('.aliyuncs.com') ? 'upload' : u.pathname === '/materials/one' ? 'material' : null) : null;
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        const state = window.__productionUpload, kind = this.__productionUploadKind;
        if (state && kind) {
          state.stage = kind; state.changed = Date.now(); state.stageSince = Date.now();
          if (kind === 'upload') state.started = true;
          this.upload.addEventListener('progress', e => {
            if (kind === 'upload' && e.loaded > state.loaded) {
              state.loaded = e.loaded; state.total = e.total; state.changed = Date.now();
            }
          });
          this.addEventListener('loadend', () => {
            state.changed = Date.now();
            if (this.status < 200 || this.status >= 300) state.error = `${kind}_http_${this.status}`;
            else { state.stage = kind === 'upload' ? 'material' : 'canvas'; state.stageSince = Date.now(); }
          });
        }
        return send.apply(this, arguments);
      };
      window.__productionUploadHook = true;
    }
    window.__productionUpload = {sideId, stage:'starting', started:false, loaded:0, total:0, changed:Date.now(), stageSince:Date.now()};
  }, sideId);
}

export function uploadDeadline(state, now, started) {
  if (state.error) return state.error;
  if (now - started > 20 * 60 * 1000) return 'upload_total_timeout';
  if (state.stage === 'material' || state.stage === 'canvas') {
    if (now - state.stageSince > 180000) return `${state.stage}_timeout`;
  } else if (now - state.changed > 120000) return 'upload_no_progress_timeout';
  return null;
}

export async function waitForUploadedImage(page, sideId) {
  const started = Date.now(); let lastLog = 0;
  while (true) {
    const result = await page.evaluate(() => ({state:window.__productionUpload,
      active:String(window.__productionStore.activeLayerId),
      images:window.__productionStore.canvasRef.canvas.getObjects().filter(o=>o.type==='image').length}));
    if (result.active !== sideId) throw new Error('active_side_changed_during_upload');
    if (result.images > 1) throw new Error('duplicate_uploaded_images');
    if (result.images === 1) return;
    const now = Date.now(), state = result.state;
    if (now - lastLog >= 10000) {
      console.log('production_upload_progress', JSON.stringify({sideId,stage:state.stage,loaded:state.loaded,total:state.total,percent:state.total?Math.round(state.loaded/state.total*100):0}));
      lastLog = now;
    }
    const error = uploadDeadline(state, now, started);
    if (error) throw new Error(`${error}:side=${sideId},bytes=${state.loaded}/${state.total}`);
    await page.waitForTimeout(1000);
  }
}
