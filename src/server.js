/** SDS 下单 worker：从 pod-api 取「已购买但还没跟 SDS 交互」的拍平输入，
 *  在 SDS 设计器里逐片复现 → 选尺码/数量 → 加入购物车 → 回写状态。
 *
 *  参考 1688 采集器：常驻 headless Chromium + 持久 profile；
 *  POST /api/browser-mode/login 切到可视 Chromium + noVNC 人工登录，
 *  POST /api/browser-mode/worker 存好登录态切回 headless。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PodApi } from './pod-api.js';
import { runIntake } from './sds-driver.js';

const PORT = Number(process.env.PORT || 8080);
const PROFILE_PATH = process.env.PROFILE_PATH || '/app/storage/browser-profile';
const STORAGE_PATH = process.env.STORAGE_PATH || '/app/storage';
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const VNC_USER = process.env.VNC_USER || 'hongxiu';
const VNC_PASSWORD = process.env.VNC_PASSWORD || '';
const DISPLAY = process.env.DISPLAY || ':99';
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);
const DAILY_AT = process.env.DAILY_AT || '';
const SDS_LOGIN_URL = process.env.SDS_LOGIN_URL || 'https://www.sdsdiy.com/user/login';

const pod = new PodApi();
const state = {
  browserMode: 'headless', /* headless | login */
  context: null,
  helpers: [],
  job: null,
  running: false,
  logs: [],
  userAgent: process.env.SDS_USER_AGENT || '',
  xReady: false,
  lastRunAt: null,
  lastError: null,
  bootedAt: new Date().toISOString()
};

function log(...args) {
  const line = `[worker ${new Date().toISOString()}] ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`;
  console.log(line);
  state.logs.push(line);
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
}

/* 持久卷自检：boots.log 跨重启保留 => 卷挂上了（SDS 登录态也就能留住） */
function storageProbe() {
  const marker = path.join(STORAGE_PATH, 'boots.log');
  try {
    fs.mkdirSync(STORAGE_PATH, { recursive: true });
    fs.appendFileSync(marker, `${new Date().toISOString()}\n`);
    const lines = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    return { path: STORAGE_PATH, persistent: lines.length > 1, firstBootAt: lines[0], boots: lines.length };
  } catch (error) {
    return { path: STORAGE_PATH, persistent: false, error: String(error?.message || error).slice(0, 200) };
  }
}

const STORAGE = storageProbe();

/* ----------------------------- 浏览器生命周期 ----------------------------- */
async function launchPersistent({ headless }) {
  const { chromium } = await import('playwright');
  fs.mkdirSync(PROFILE_PATH, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_PATH, {
    headless,
    viewport: headless ? { width: 1440, height: 1000 } : null,
    locale: 'zh-CN',
    userAgent: state.userAgent || undefined,
    env: { ...process.env, DISPLAY: headless ? process.env.DISPLAY : DISPLAY },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      /* SDS 的「加入购物车」是 window.open 打开购物车 tab —— 默认弹窗拦截会把它挡掉，加购就静默失败 */
      '--disable-popup-blocking',
      /* SDS 设计器要 WebGL（three.js）；headless 下必须开 SwiftShader 软渲染，否则一直卡骨架屏 */
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl'
    ]
  });
}

async function ensureX() {
  if (state.xReady) return;
  if (!state.helpers.some((child) => child.__kind === 'xvfb')) {
    const xvfb = spawnHelper('Xvfb', [DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp']);
    xvfb.__kind = 'xvfb';
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const wm = spawnHelper('fluxbox', []);
    wm.__kind = 'fluxbox';
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  state.xReady = true;
  log('X (Xvfb + fluxbox) ready');
}

async function ensureVnc() {
  await ensureX();
  if (state.helpers.some((child) => child.__kind === 'x11vnc')) return;
  const vnc = spawnHelper('x11vnc', ['-display', DISPLAY, '-rfbport', '5900', '-localhost', '-forever', '-shared', '-nopw']);
  vnc.__kind = 'x11vnc';
  const ws = spawnHelper('websockify', [`127.0.0.1:${NOVNC_PORT}`, '127.0.0.1:5900', '--web=/usr/share/novnc']);
  ws.__kind = 'websockify';
  await new Promise((resolve) => setTimeout(resolve, 1500));
  log('noVNC (x11vnc + websockify) ready');
}

/** worker 模式：有头跑在 Xvfb 里（SDS 设计器要 WebGL，headless shell 给不出来），但不暴露 VNC */
async function ensureHeadless() {
  if (state.browserMode === 'login') throw new Error('browser_in_login_mode');
  if (state.context && state.browserMode === 'headless') return state.context;
  if (state.context) await closeContext();
  await ensureX();
  state.context = await launchPersistent({ headless: false });
  state.browserMode = 'headless';
  log('worker browser ready (headed under Xvfb)');
  return state.context;
}

async function closeContext() {
  if (!state.context) return;
  try {
    await state.context.storageState({ path: path.join(path.dirname(PROFILE_PATH), 'storage-state.json') });
  } catch (error) {
    log('storageState save failed', String(error).slice(0, 200));
  }
  await state.context.close().catch(() => {});
  state.context = null;
}

function spawnHelper(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', detached: false });
  child.on('exit', (code) => log(`helper ${command} exited ${code}`));
  state.helpers.push(child);
  return child;
}

async function enterLoginMode() {
  if (state.browserMode === 'login') return { mode: 'login', novncUrl: novncUrl() };
  await closeContext();
  await ensureVnc();
  state.context = await launchPersistent({ headless: false });
  const page = state.context.pages()[0] || (await state.context.newPage());
  await page.goto(SDS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  state.browserMode = 'login';
  log('login mode ready (novnc)');
  return { mode: 'login', novncUrl: novncUrl(), loginUrl: page.url() };
}

function novncUrl() {
  /* path 显式指定，避免 noVNC 自己按当前目录猜 websockify 路径 */
  const query = 'autoconnect=1&resize=scale&path=%2Fvnc%2Fwebsockify';
  const base = process.env.PUBLIC_BASE_URL || '';
  return base ? `${base.replace(/\/+$/, '')}/vnc/vnc.html?${query}` : `http://127.0.0.1:${NOVNC_PORT}/vnc.html?${query}`;
}

async function exitLoginMode() {
  await closeContext();
  /* 只收掉 VNC 相关的进程；Xvfb/fluxbox 留着给 worker 模式用 */
  for (const helper of state.helpers.filter((child) => child.__kind === 'x11vnc' || child.__kind === 'websockify')) {
    try { helper.kill('SIGTERM'); } catch { /* ignore */ }
  }
  state.helpers = state.helpers.filter((child) => child.__kind === 'xvfb' || child.__kind === 'fluxbox');
  state.context = null;
  await ensureHeadless();
  return { mode: state.browserMode };
}

/* --------------------------------- 任务 --------------------------------- */
function summarize(intake) {
  const lines = PodApi.cartLines(intake);
  return {
    id: intake.id,
    productId: intake.productId,
    productName: intake.productName,
    designId: intake.designId,
    modeKind: intake.modeKind,
    sides: (intake.sides ?? []).map((side) => ({ sideId: side.sideId, name: side.name, width: side.width, height: side.height })),
    orders: (intake.orders ?? []).length,
    cartLines: lines
  };
}

async function runJob(options = {}) {
  const limit = Math.min(Number(options.limit) || 5, 50);
  const includeUnordered = !!options.includeUnordered;
  const dryRun = options.dryRun === undefined ? true : !!options.dryRun;
  const writeBack = !!options.writeBack;
  const job = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), dryRun, options: { limit, includeUnordered, writeBack, intakeId: options.intakeId ?? null }, items: [], finishedAt: null, error: null };
  state.job = job;
  state.running = true;
  state.lastRunAt = job.startedAt;
  if (state.browserMode === 'login') {
    /* 人工登录期间绝不抢浏览器：抢了会把 noVNC 里的登录态打断 */
    job.error = 'browser_in_login_mode';
    job.finishedAt = new Date().toISOString();
    state.running = false;
    log('job skipped: browser is in login mode');
    return job;
  }
  log(`job ${job.id} start dryRun=${dryRun} limit=${limit}`);
  try {
    let intakes;
    if (options.intakeId) {
      const single = await pod.getIntake(String(options.intakeId));
      if (!single) throw new Error('intake_not_found');
      if (!includeUnordered && !(single.orders ?? []).length) throw new Error('intake_has_no_order');
      intakes = [single];
    } else {
      intakes = await pod.pendingIntakes({ limit, includeUnordered });
    }
    for (const intake of intakes) {
      const plan = summarize(intake);
      if (dryRun) {
        job.items.push({ ...plan, status: 'planned' });
        log('planned', plan.id, plan.productId, plan.modeKind, JSON.stringify(plan.cartLines));
        continue;
      }
      try {
        const manifest = await pod.manifest(intake.productId).catch(() => null);
        const context = await ensureHeadless();
        const page = context.pages()[0] || (await context.newPage());
        const result = await runIntake(page, intake, plan.cartLines, {
          designProductId: manifest?.designProductId ?? String(Number(intake.productId) + 1),
          fetchSide: (intakeId, sideId) => pod.sideBytes(intakeId, sideId)
        });
        await page.goto('about:blank').catch(() => {});
        const cartOk = (result.carts || []).length > 0 && (result.carts || []).every((cart) => cart.clicked);
        const sds = { cartAddedAt: new Date().toISOString(), designerUrl: result.url, mode: result.mode, saved: result.saved, pieces: result.sides, carts: result.carts, screenshot: result.screenshot };
        if (!cartOk) {
          /* 加了但购物车里没多出来 → 不能算成功，写 failed 让人工看 diag */
          sds.note = 'cart_not_verified';
          await pod.reportSds(intake.id, { status: 'failed', sds, error: 'cart_add_failed' });
          job.items.push({ ...plan, status: 'failed', error: 'cart_add_failed', sds });
          log('cart_add_failed', plan.id, JSON.stringify(result.carts));
          continue;
        }
        await pod.reportSds(intake.id, { status: 'cart_added', sds });
        job.items.push({ ...plan, status: 'cart_added', sds });
        log('cart_added', plan.id, JSON.stringify(result.carts.map((cart) => cart.toast)));
      } catch (error) {
        const message = String(error?.message || error).slice(0, 1000);
        if (writeBack) await pod.reportSds(intake.id, { status: 'failed', error: message }).catch(() => {});
        job.items.push({ ...plan, status: 'failed', error: message });
        log('failed', plan.id, message);
      }
    }
  } catch (error) {
    job.error = String(error?.message || error);
    state.lastError = job.error;
    log('job error', job.error);
  }
  job.finishedAt = new Date().toISOString();
  state.running = false;
  log(`job ${job.id} done items=${job.items.length}`);
  return job;
}

/* --------------------------------- HTTP --------------------------------- */
function json(res, code, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function authorized(req) {
  if (!WORKER_SECRET) return true;
  const supplied = String(req.headers['x-worker-secret'] || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(WORKER_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorizedQuery(req, url) {
  if (authorized(req)) return true;
  if (!WORKER_SECRET) return true;
  const supplied = String(url.searchParams.get('secret') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(WORKER_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function currentPage() {
  if (!state.context) return null;
  try {
    if (state.context.pages().length === 0) {
      /* 有头模式下关掉最后一个页面会让浏览器进程退出——按需补一个空白页 */
      await state.context.newPage();
    }
    const pages = state.context.pages();
    return pages[pages.length - 1] ?? null;
  } catch (error) {
    log(`[browser] context unusable (${String(error?.message || error).slice(0, 80)}), will relaunch`);
    state.context = null;
    state.browserMode = 'headless';
    return null;
  }
}

/* ---------------------- noVNC 反代（带 Basic Auth） ----------------------
 * 容器里 websockify 只监听 127.0.0.1:6080；这里把 /vnc/* 反代过去，
 * 这样登录页走 Coolify 的 HTTPS 域名，而且外面还有一道 Basic Auth。 */
function basicAuthOk(req) {
  if (!VNC_PASSWORD) return true;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  const user = decoded.slice(0, index);
  const pass = decoded.slice(index + 1);
  return user === VNC_USER && pass === VNC_PASSWORD;
}

function denyVnc(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="sds-worker-vnc"', 'Content-Type': 'text/plain' });
  res.end('authentication required');
}

function proxyVncHttp(req, res) {
  if (!basicAuthOk(req)) return denyVnc(res);
  const raw = req.url || '/';
  const target = raw.startsWith('/vnc') ? (raw.replace(/^\/vnc/, '') || '/') : raw;
  const upstream = http.request({ host: '127.0.0.1', port: NOVNC_PORT, path: target, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` } }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('novnc upstream unavailable (switch to login mode first)');
  });
  req.pipe(upstream);
}

function proxyVncUpgrade(req, socket, head) {
  const raw = req.url || '/';
  const target = raw.startsWith('/vnc') ? (raw.replace(/^\/vnc/, '') || '/') : raw;
  if (!basicAuthOk(req)) {
    log(`[vnc] upgrade rejected (auth) path=${raw}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="sds-worker-vnc"\r\n\r\n');
    return socket.destroy();
  }
  const upstream = net.connect(NOVNC_PORT, '127.0.0.1', () => {
    const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` }).map(([key, value]) => `${key}: ${value}`).join('\r\n');
    upstream.write(`${req.method} ${target} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  let first = true;
  upstream.on('data', (chunk) => {
    if (!first) return;
    first = false;
    const head = chunk.toString('utf8', 0, 60).split('\r\n')[0];
    log(`[vnc] upgrade ${target} -> ${/101/.test(head) ? '101 ok' : head}`);
  });
  upstream.on('error', (error) => {
    log(`[vnc] upgrade failed path=${raw} err=${String(error?.message || error)}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
}

/** websockify 是否在听（login 模式下才有） */
function novncReachable() {
  return new Promise((resolve) => {
    const socket = net.connect(NOVNC_PORT, '127.0.0.1');
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(1500);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/vnc' || url.pathname.startsWith('/vnc/') || url.pathname === '/websockify') {
      /* 方便直接访问 /vnc → noVNC 客户端（/websockify 也直通，兼容 noVNC 自己算出来的路径） */
      if (url.pathname === '/vnc' || url.pathname === '/vnc/') {
        res.writeHead(302, { Location: '/vnc/vnc.html?autoconnect=1&resize=scale&path=%2Fvnc%2Fwebsockify' });
        return res.end();
      }
      return proxyVncHttp(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        service: 'sds-order-worker',
        version: '0.1.0',
        browserMode: state.browserMode,
        browser: !!state.context,
        podApi: pod.base,
        podApiKey: !!pod.key,
        helperProcesses: state.helpers.length,
        bootedAt: state.bootedAt,
        storage: STORAGE,
        novnc: { port: NOVNC_PORT, url: novncUrl(), reachable: await novncReachable(), passwordSet: !!VNC_PASSWORD },
        lastRunAt: state.lastRunAt,
        lastError: state.lastError,
        job: state.job ? { id: state.job.id, dryRun: state.job.dryRun, items: state.job.items.length, finishedAt: state.job.finishedAt } : null
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      const includeUnordered = url.searchParams.get('includeUnordered') === '1';
      const limit = Number(url.searchParams.get('limit') || 20);
      const intakes = await pod.pendingIntakes({ limit, includeUnordered });
      return json(res, 200, { pending: intakes.length, items: intakes.map(summarize) });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser') {
      if (!authorizedQuery(req, url)) return json(res, 401, { error: 'unauthorized' });
      const page = await currentPage();
      return json(res, 200, {
        mode: state.browserMode,
        pages: state.context ? state.context.pages().length : 0,
        url: page ? page.url() : null,
        title: page ? await page.title().catch(() => null) : null
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/screenshot') {
      if (!authorizedQuery(req, url)) return json(res, 401, { error: 'unauthorized' });
      const page = await currentPage();
      if (!page) return json(res, 409, { error: 'no_browser', hint: '先 POST /api/browser-mode/login 或跑一次任务' });
      const shot = await page.screenshot({ type: 'png' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': shot.length, 'Cache-Control': 'no-store' });
      return res.end(shot);
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/session') {
      /* 把别处（操作者本机浏览器）已经登录好的会话灌进来：cookie + localStorage。
         用于绕开短信登录/风控——token 在 SDS 的 localStorage 里。 */
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const origin = String(body.origin || 'https://www.sdsdiy.com');
      const cookies = Array.isArray(body.cookies) ? body.cookies : [];
      const storage = body.localStorage && typeof body.localStorage === 'object' ? body.localStorage : {};
      if (!cookies.length && !Object.keys(storage).length) return json(res, 400, { error: 'empty_session' });
      /* 会话来自操作者本机浏览器：UA 也一起带上，指纹更一致 */
      const incomingUa = String(body.userAgent || '');
      if (incomingUa && incomingUa !== state.userAgent) {
        state.userAgent = incomingUa;
        await closeContext();
        state.context = null;
        log(`[session] user-agent adopted (${incomingUa.slice(0, 40)}...)`);
      }
      const context = await ensureHeadless();
      if (cookies.length) {
        await context.addCookies(cookies.map((cookie) => ({
          name: String(cookie.name),
          value: String(cookie.value),
          domain: cookie.domain ? String(cookie.domain) : undefined,
          url: cookie.domain ? undefined : origin,
          path: cookie.path ? String(cookie.path) : '/',
          httpOnly: !!cookie.httpOnly,
          secure: cookie.secure !== false,
          sameSite: cookie.sameSite || 'Lax',
          expires: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : undefined
        })));
      }
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      if (Object.keys(storage).length) {
        await page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            try { window.localStorage.setItem(key, value); } catch (error) { /* ignore */ }
          }
        }, storage);
      }
      const probe = String(body.probeUrl || '');
      await page.goto(probe || origin, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const finalUrl = page.url();
      log(`[session] applied cookies=${cookies.length} localStorage=${Object.keys(storage).length} -> ${finalUrl}`);
      return json(res, 200, {
        applied: { cookies: cookies.length, localStorage: Object.keys(storage).length },
        url: finalUrl,
        title: await page.title().catch(() => null),
        loggedIn: !/\/user\/login/.test(finalUrl)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/eval') {
      /* 在容器浏览器当前页面里求值，用于排障（返回 JSON，别塞大对象） */
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const expression = String(body.expression || '');
      if (!expression) return json(res, 400, { error: 'empty_expression' });
      const page = await currentPage();
      if (!page) return json(res, 409, { error: 'no_browser', hint: '先跑一次任务或 goto' });
      try {
        const value = await page.evaluate(expression);
        return json(res, 200, { ok: true, value });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error?.message || error).slice(0, 500) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/goto') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      if (!body.url || !/^https:\/\//.test(String(body.url))) return json(res, 400, { error: 'invalid_url' });
      const page = await currentPage();
      if (!page) return json(res, 409, { error: 'no_browser', hint: '先 POST /api/browser-mode/login' });
      await page.goto(String(body.url), { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      return json(res, 200, { url: page.url(), title: await page.title().catch(() => null) });
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      if (!authorizedQuery(req, url)) return json(res, 401, { error: 'unauthorized' });
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 300);
      return json(res, 200, { count: state.logs.length, lines: state.logs.slice(-limit) });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs/last') return json(res, 200, state.job ?? {});
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const id = url.pathname.split('/').pop();
      if (!state.job || state.job.id !== id) return json(res, 404, { error: 'job_not_found' });
      return json(res, 200, state.job);
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (state.browserMode === 'login') return json(res, 409, { error: 'browser_in_login_mode', hint: '先 POST /api/browser-mode/worker 切回 headless' });
      if (state.running) return json(res, 409, { error: 'job_running', id: state.job?.id });
      const body = await readBody(req);
      state.running = true;
      runJob(body).catch((error) => { state.running = false; state.lastError = String(error?.message || error); });
      return json(res, 202, { accepted: true, dryRun: body.dryRun === undefined ? true : !!body.dryRun, poll: '/api/jobs/last' });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser-mode/login') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const result = await enterLoginMode();
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/browser-mode/worker') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const result = await exitLoginMode();
      return json(res, 200, result);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, 500, { error: 'internal_error', message: String(error?.message || error) });
  }
});

/* ------------------------------- 每日定时跑 ------------------------------- */
function scheduleDaily() {
  if (!DAILY_AT) return;
  const [hour, minute] = DAILY_AT.split(':').map((value) => Number(value));
  let lastDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === hour && now.getMinutes() === minute && lastDay !== day) {
      lastDay = day;
      log('daily run triggered');
      runJob({ dryRun: process.env.DRY_RUN === '1', writeBack: true, limit: Number(process.env.DAILY_LIMIT || 20), includeUnordered: false }).catch((error) => log('daily run failed', String(error)));
    }
  }, 60_000);
}

server.on('upgrade', (req, socket, head) => {
  const path = String(req.url || '');
  if (path.startsWith('/vnc/') || path === '/websockify') return proxyVncUpgrade(req, socket, head);
  socket.destroy();
});

server.listen(PORT, () => {
  log(`listening on :${PORT} (pod-api ${pod.base}, key=${pod.key ? 'set' : 'missing'})`);
  scheduleDaily();
  if (process.env.RUN_ON_START === '1') runJob({ dryRun: process.env.DRY_RUN === '1', writeBack: true }).catch((error) => log('startup run failed', String(error)));
});

process.on('SIGTERM', async () => {
  await closeContext();
  server.close(() => process.exit(0));
});
