# sds-order-worker

把 SP 侧 POD 设计器「拍平的设计输入」按订单在 **SDS 设计器**里复现并加入购物车。

设计原则：**SP 的购买 / 与 SDS 的交互是两件事**。
- SP 侧：Complete design 时把拍平图存进 pod-api（`/v1/intakes`），**不碰 SDS**。
- 本 worker：定时（或手动）从 pod-api 取「已购买但还没与 SDS 交互」的 intake，逐条在 SDS 里复现 → 选尺码/数量 → 加入购物车 → 回写状态。

## 流程（一条 intake）

1. `GET /v1/intakes?status=pending` → 逐条取详情（拿到绑定的订单尺码/数量）。
2. 打开 `https://www.sdsdiy.com/portal/detail/design/{productId}/{designProductId}`。
3. 按 `modeKind` 切模板：`single` → 「多拼」，`all` → 「单图」。
4. 逐片：切到该版片 → 打开「上传」面板 → 把 pod-api 上的拍平 PNG 塞进它的 file input
   （走 SDS 自己的 OSS + `materials/one` 链路，自动贴到该片印花区；不手动拖拽、不改它的内部状态）。
5. 点「保 存」保存设计。
6. 按订单尺码/数量：点尺码 → 填数量 → 点「加入购物车」。
7. `POST /v1/intakes/{id}/sds` 回写 `cart_added`（失败写 `failed` + 原因），附设计器 URL、每片结果、购物车结果、截图路径。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 状态（浏览器模式、队列、pod-api 配置） |
| GET | `/api/queue[?includeUnordered=1&limit=N]` | 当前待交互队列 + 计划（含尺码/数量） |
| POST | `/api/run` | 跑一批：`{limit, includeUnordered, dryRun=true, writeBack}` |
| GET | `/api/jobs/{id}` / `/api/jobs/last` | 任务状态 |
| POST | `/api/browser-mode/login` | 切到可视 Chromium + noVNC，人工登录 SDS |
| POST | `/api/browser-mode/worker` | 存好登录态、关掉可视浏览器、切回 headless |
| GET | `/vnc/` | noVNC 客户端（服务内反代 websockify，外面套 Basic Auth） |

写操作需要 `x-worker-secret: $WORKER_SECRET`（留空则不校验，仅建议内网使用）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `POD_API_BASE` | 默认 `https://pod-api.wearhongxiu.com` |
| `POD_API_KEY` | pod-api 写接口的 key（`~/.wp-pod/api-key.txt` 同值） |
| `WORKER_SECRET` | 保护 `/api/*` |
| `VNC_USER` / `VNC_PASSWORD` | noVNC 的 Basic Auth（`VNC_PASSWORD` 为空则不校验，**公网部署务必设置**） |
| `PROFILE_PATH` / `STORAGE_PATH` | 浏览器 profile（登录态）与截图目录，**必须挂持久卷** |
| `DAILY_AT` | 例如 `03:30`，每天这个时间自动跑一批（`DRY_RUN=1` 则只出计划） |
| `RUN_ON_START=1` | 启动即跑一批 |
| `PUBLIC_BASE_URL` | 反代地址，用于拼 noVNC 链接 |

## 本地/服务器

```bash
npm install
POD_API_KEY=... node src/server.js        # 起服务
curl -s localhost:8080/api/queue | jq     # 看队列
curl -s -XPOST localhost:8080/api/run -H 'content-type: application/json' -d '{"dryRun":true}' | jq
```

Docker（Coolify 用同一个 Dockerfile；Docker 里才有 Chromium + noVNC）：

```bash
docker build -t sds-order-worker .
docker run --rm -p 8080:8080 -p 6080:6080 \
  -e POD_API_KEY=... -e WORKER_SECRET=... -e DAILY_AT=03:30 \
  -v sds-worker-storage:/app/storage sds-order-worker
```

## 首次登录

1. `POST /api/browser-mode/login`（带 `x-worker-secret`）→ 返回 noVNC 链接。
2. 打开 `https://<应用域名>/vnc/`，用 `VNC_USER` / `VNC_PASSWORD` 过 Basic Auth，在画面里手动登录 SDS（账号只留在 profile 卷里，不落库）。
3. `POST /api/browser-mode/worker` → 切回 headless，之后定时任务复用这份登录态。

> 容器内 websockify 只监听 `127.0.0.1:6080`，外部一律通过服务自身 `/vnc/*` 反代（HTTP + WebSocket），
> 所以只需要暴露应用端口（8080），不用额外开放 6080。
