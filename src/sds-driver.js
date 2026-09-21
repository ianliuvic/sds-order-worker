/** SDS 设计器驱动：把一个 intake 的拍平面逐片注入 → 保存 → 选尺码数量 → 加入购物车
 *
 * 说明：SDS 的 class 名带构建哈希（sizeItem__style-XXXX），所以选择器一律
 * 用「class 前缀 + 文本」定位，不用整串哈希。
 */
import fs from 'node:fs';
import path from 'node:path';

const DESIGNER_MODE = { single: '多拼', all: '单图' };
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const STORAGE_PATH = process.env.STORAGE_PATH || '/app/storage';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function designerUrl(productId, designProductId) {
  return `https://www.sdsdiy.com/portal/detail/design/${productId}/${designProductId}`;
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/\/user\/login/.test(url)) throw new Error('sds_needs_login');
  const needsLogin = await page.evaluate(() => !!document.querySelector('input[type=password]') || /请登录|登录后/.test(document.body.innerText || ''));
  if (needsLogin) throw new Error('sds_needs_login');
}

/** 只读：设计器当前画布上的图层数（验证拍平图确实落到了画布） */
async function canvasLayerCount(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    let seed = null;
    for (const el of all) {
      const key = Object.keys(el).find((k) => /^__reactInternalInstance\$/.test(k));
      if (key) { seed = el[key]; break; }
    }
    if (!seed) return null;
    let top = seed;
    while (top && top.return) top = top.return;
    const queue = [top];
    let seen = 0;
    while (queue.length && seen < 6000) {
      const fiber = queue.shift();
      seen += 1;
      const node = fiber.stateNode;
      if (node && typeof node === 'object' && typeof node.renderPSD === 'function' && node.vetrina) {
        const store = node.store || (node.props && node.props.store);
        const layers = store && store.canvasLayers;
        return Array.isArray(layers) ? layers.length : (layers ? Object.keys(layers).length : null);
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  });
}

async function clickByText(page, pattern, { exact = false, root = null } = {}) {
  const handle = await page.evaluateHandle(
    ({ source, flags, exactMatch, rootSelector }) => {
      const re = new RegExp(source, flags);
      const scope = rootSelector ? document.querySelector(rootSelector) : document;
      if (!scope) return null;
      const candidates = [...scope.querySelectorAll('div,span,button,a,li,label')];
      const visible = candidates.filter((el) => el.offsetParent !== null && (el.children.length === 0 || exactMatch));
      const hit = visible.find((el) => {
        const text = (el.textContent || '').trim();
        return exactMatch ? text === source : re.test(text);
      });
      if (!hit) return null;
      const clickable = hit.closest('button,[role=button],[class*=btn],div,span') || hit;
      clickable.click();
      return (hit.textContent || '').trim();
    },
    { source: pattern.source ?? String(pattern), flags: pattern.flags ?? '', exactMatch: exact, rootSelector: root }
  );
  const value = await handle.jsonValue();
  await handle.dispose();
  return value;
}

async function selectMode(page, kind) {
  const wanted = DESIGNER_MODE[kind] ?? DESIGNER_MODE.single;
  return page.evaluate((label) => {
    const groups = [...document.querySelectorAll('[class*="groupItem__style"]')];
    const target = groups.find((el) => (el.textContent || '').includes(label));
    if (!target) return 'group_not_found';
    if (/active__/.test(target.innerHTML)) return 'already_active';
    const clickable = target.querySelector('[class*="name__style"]') || target;
    clickable.click();
    return 'clicked';
  }, wanted);
}

async function selectFace(page, name, index = 0) {
  return page.evaluate(({ faceName, faceIndex }) => {
    const boxes = [...document.querySelectorAll('[class*="faces__style"]')];
    const scope = boxes[0] || document.body;
    const labels = [...scope.querySelectorAll('[class*="name__style"]')].filter((el) => (el.textContent || '').trim());
    let label = labels.find((el) => (el.textContent || '').trim() === faceName);
    if (!label) label = labels[faceIndex]; /* 名字对不上时退回按顺序取 */
    if (!label) return 'face_not_found';
    const item = label.closest('[class*="item__style"]') || label.parentElement || label;
    if (/active__/.test((item.className || ''))) return 'already_active';
    item.click();
    return 'clicked';
  }, { faceName: name, faceIndex: index });
}

async function openUploadTab(page) {
  return clickByText(page, '上传', { exact: true });
}

async function uploadSide(page, { name, mime, buffer, fileName, index, expectLayers = 1 }) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const face = await selectFace(page, name, index);
    await sleep(1500);
    await openUploadTab(page);
    await sleep(700);
    const input = page.locator('input[type=file]').first();
    await input.waitFor({ state: 'attached', timeout: 15000 });
    await input.setInputFiles({ name: fileName, mimeType: mime || 'image/png', buffer });
    /* 轮询等「上传 OSS + materials/one + 自动贴片」，比固定 sleep 稳 */
    const deadline = Date.now() + 25000;
    let layers = await canvasLayerCount(page);
    while (Date.now() < deadline && (layers === null || layers < expectLayers)) {
      await page.waitForTimeout(1000);
      layers = await canvasLayerCount(page);
    }
    if (layers !== null && layers >= expectLayers) return { face, layers, attempts: attempt };
    if (attempt === 2) return { face, layers, attempts: attempt, warning: 'layer_count_not_increased' };
  }
  return { face: 'unreachable', layers: null };
}

async function saveDesign(page) {
  /* 同样是真实点击：DOM .click() 在 SDS 上不可靠 */
  const result = { clicked: false, confirmClicked: false, toasts: [] };
  const button = page.locator('button:visible').filter({ hasText: /^保\s*存$/ }).first();
  try {
    await button.waitFor({ state: 'visible', timeout: 10000 });
    await button.click({ timeout: 10000 });
    result.clicked = true;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 200);
  }
  await page.waitForTimeout(2500);
  const confirm = page.locator('button:visible').filter({ hasText: /^确\s*认$/ }).first();
  if (await confirm.count()) {
    try { await confirm.click({ timeout: 5000 }); result.confirmClicked = true; } catch (error) { /* ignore */ }
    await page.waitForTimeout(1500);
  }
  result.toasts = await page.evaluate(() => [...document.querySelectorAll('.ant-message-notice,.ant-notification-notice')]
    .map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 3));
  return result;
}

const CART_URL = 'https://www.sdsdiy.com/admin/shopping-cart';

/** 打开购物车读一次行文本（用于「点完到底进没进车」的判定） */
async function cartRowTexts(context) {
  let page = null;
  try {
    page = await context.newPage();
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    return await page.evaluate(() => [...document.querySelectorAll('tr')]
      .map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 20));
  } catch (error) {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function selectSize(page, size) {
  /* 用真实点击（DOM 的 .click() 触发不了 SDS 的加购/选码逻辑） */
  const chip = page.locator('[class*="sizeItem__style"]').filter({ hasText: new RegExp(`^${size}$`) }).first();
  try {
    await chip.waitFor({ state: 'visible', timeout: 10000 });
    await chip.click({ timeout: 10000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function setQuantity(page, quantity) {
  const qty = page.locator('input.ant-input-number-input').first();
  if (!(await qty.count())) return false;
  try {
    await qty.click({ timeout: 8000 });
    await qty.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a').catch(() => {});
    await qty.type(String(quantity), { delay: 40 });
    await qty.press('Enter').catch(() => {});
    await page.waitForTimeout(600);
    return true;
  } catch (error) {
    return false;
  }
}

/** 等可见的「加入购物车」变可用，然后**真实点击**（Playwright 会做可点性检查） */
async function clickAddToCart(page, timeoutMs = 20000) {
  const button = page.locator('button:visible').filter({ hasText: '加入购物车' }).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await button.isEnabled()) {
        await button.click({ timeout: 8000 });
        return true;
      }
    } catch (error) {
      /* 还在切换态，继续等 */
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/** 点完页脚「加入购物车」后 SDS 会弹一个 antd Popconfirm（素材尺寸不足，建议重新设计），
 *  必须在**该弹窗作用域内**点它的「加入购物车」才算真正加购；没弹也属正常（尺寸充足）。 */
async function confirmPopconfirm(page, timeoutMs = 8000) {
  const pop = page.locator('.ant-popconfirm:visible').first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await pop.count() && await pop.isVisible()) {
        const text = ((await pop.innerText()) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const confirm = pop.locator('button').filter({ hasText: /^加入购物车$/ }).first();
        let clicked = false;
        try {
          await confirm.click({ timeout: 6000 });
          clicked = true;
        } catch (error) {
          /* 点不到就退回：把弹窗里的按钮都记下来 */
        }
        const buttons = await pop.locator('button').allInnerTexts().catch(() => []);
        return { appeared: true, text, clicked, buttons: buttons.map((b) => (b || '').replace(/\s+/g, ' ').trim()) };
      }
    } catch (error) {
      /* 弹窗正在切换，继续等 */
    }
    await page.waitForTimeout(500);
  }
  return { appeared: false };
}

/** 加购 + 核对：页脚点击 → Popconfirm 二次确认 → 以「购物车行数是否增加」为准，没涨就再试一次 */
async function addToCart(page, { size, quantity }) {
  const context = page.context();
  const baseline = await cartRowTexts(context);
  const result = {
    size,
    quantity,
    attempts: 0,
    clicked: false,
    cartRowsBefore: baseline ? baseline.length : null,
    cartRowsAfter: null,
    popupUrl: null,
    diag: []
  };
  const qtyInput = page.locator('input.ant-input-number-input').first();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result.attempts = attempt;
    await page.bringToFront().catch(() => {});
    const sizeOk = await selectSize(page, size);
    await page.waitForTimeout(800);
    const qtyOk = await setQuantity(page, quantity);
    const state = await page.evaluate(() => ({
      activeSize: (() => {
        const active = [...document.querySelectorAll('[class*="sizeItem__style"]')].find((el) => /active__/.test(el.className || ''));
        return active ? (active.textContent || '').trim() : null;
      })(),
      buttons: [...document.querySelectorAll('button')]
        .filter((el) => /加入购物车/.test(el.innerText || ''))
        .map((el) => ({ visible: el.offsetParent !== null, disabled: !!el.disabled, cls: String(el.className).slice(0, 50) })),
      bodyHint: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-160)
    }));
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    const buttonClicked = await clickAddToCart(page);
    const confirmation = buttonClicked ? await confirmPopconfirm(page) : { appeared: false };
    const popup = buttonClicked ? await popupPromise : null;
    await page.waitForTimeout(1200);
    const afterClickState = await page.evaluate(() => ({
      toasts: [...document.querySelectorAll('.ant-message-notice,.ant-notification-notice')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 3),
      modals: [...document.querySelectorAll('.ant-modal')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120)).slice(0, 2),
      url: location.href
    }));
    if (popup) {
      result.popupUrl = popup.url();
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.close().catch(() => {});
    }
    await page.waitForTimeout(2500);
    const after = await cartRowTexts(context);
    result.cartRowsAfter = after ? after.length : null;
    result.diag.push({
      attempt,
      sizeOk,
      qtyOk,
      qtyValue: await qtyInput.inputValue().catch(() => null),
      activeSize: state.activeSize,
      buttons: state.buttons,
      buttonClicked,
      confirmation,
      afterClick: afterClickState,
      bodyHint: state.bodyHint
    });
    if (after && baseline && after.length > baseline.length) {
      result.clicked = true;
      result.cartRows = after;
      break;
    }
  }
  return result;
}

/** 跑一条 intake：注入所有片 → 保存 → 按订单尺码/数量加购物车 */
export async function runIntake(page, intake, cartLines, options = {}) {
  const designProductId = options.designProductId;
  const startedAt = new Date().toISOString();
  const url = designerUrl(intake.productId, designProductId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await assertLoggedIn(page);

  const mode = await selectMode(page, intake.modeKind);
  await page.waitForTimeout(4500);

  const sides = [];
  let sideIndex = 0;
  let expectedLayers = await canvasLayerCount(page);
  if (expectedLayers === null) expectedLayers = 0;
  for (const side of intake.sides ?? []) {
    const buffer = await options.fetchSide(intake.id, side.sideId);
    expectedLayers = (expectedLayers ?? 0) + 1;
    const result = await uploadSide(page, {
      name: side.name || side.sideId,
      mime: side.mime || 'image/png',
      buffer,
      fileName: `hx-${intake.id}-${side.sideId}.png`,
      index: sideIndex,
      expectLayers: expectedLayers
    });
    sideIndex += 1;
    sides.push({ sideId: side.sideId, name: side.name, ...result });
  }

  const saved = await saveDesign(page);
  const carts = [];
  for (const line of cartLines) carts.push(await addToCart(page, line));

  const shotDir = path.join(STORAGE_PATH, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const screenshot = path.join(shotDir, `${intake.id}-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});

  return { url, mode, sides, saved, carts, screenshot, startedAt, finishedAt: new Date().toISOString(), sizes: SIZES };
}
