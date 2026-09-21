# sds-order-worker 运维手册

面向操作者：每天怎么看队列、怎么跑、登录过期怎么办、失败怎么重试。

- 服务地址：`https://sds-worker.187.77.216.247.sslip.io`
- 所有 `/api/*` 都要带 `x-worker-secret`（值在本机 `~/.wp-pod/sds-worker.env` 的 `WORKER_SECRET`）
- 队列数据在 pod-api：面板 `https://pod-api.wearhongxiu.com/ops/intakes`，接口 `/v1/intakes`

## 一、日常

```bash
# 1. 看服务状态（不用鉴权）
curl -s https://sds-worker.187.77.216.247.sslip.io/health

# 2. 看今天要处理什么（默认只列「已购买」的）
curl -s -H "x-worker-secret: $SECRET" https://sds-worker.187.77.216.247.sslip.io/api/queue

# 3. 先出计划（dryRun，不动 SDS、不回写）
curl -s -XPOST -H "x-worker-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"dryRun":true}' https://sds-worker.187.77.216.247.sslip.io/api/run

# 4. 确认后真跑
curl -s -XPOST -H "x-worker-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"dryRun":false,"writeBack":true}' https://sds-worker.187.77.216.247.sslip.io/api/run

# 5. 看任务结果 / 日志
curl -s -H "x-worker-secret: $SECRET" https://sds-worker.187.77.216.247.sslip.io/api/jobs/last
curl -s -H "x-worker-secret: $SECRET" 'https://sds-worker.187.77.216.247.sslip.io/api/logs?limit=100'
```

自动跑：环境变量 `DAILY_AT=03:30` 时每天这个点自动跑一批；`DRY_RUN=1` 时只出计划。
另外 `POST /api/run` 支持 `{"intakeId":"<uuid>"}` 只跑指定那条（重试用）。

## 二、登录（一次性 / 失效时）

SDS 登录态存在持久卷的浏览器 profile 里；**重部署不会丢**，但会过期或触发风控。流程：

```bash
# 1. 切到可视浏览器（容器里会起 Xvfb + x11vnc + noVNC）
curl -s -XPOST -H "x-worker-secret: $SECRET" .../api/browser-mode/login
# 2. 浏览器打开 https://sds-worker.187.77.216.247.sslip.io/vnc/
#    Basic Auth: VNC_USER / VNC_PASSWORD（同一个 env 文件）；在画面里登录 SDS
# 3. 确认已登录
curl -s -XPOST -H "x-worker-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"url":"https://www.sdsdiy.com/portal/detail/design/246885/246886"}' .../api/browser/goto
#    → 返回的 url 里若带 /user/login 就是还没登录
# 4. 切回 headless
curl -s -XPOST -H "x-worker-secret: $SECRET" .../api/browser-mode/worker
```

> login 模式下 `POST /api/run` 会返回 **409 `browser_in_login_mode`**（定时任务也会跳过），
> 这是故意的：任务不会抢走浏览器、不会打断你正在做的登录。

## 三、失败怎么看

`GET /api/jobs/last` 里每条 item 有 `status` 与 `error`：

| error | 含义 | 处理 |
|---|---|---|
| `sds_needs_login` | 登录态没了（设计器被跳到 `/user/login`） | 走第二节重新登录 |
| `face_not_found` | SDS 里找不到该版片名 | 看 `sides[].face`，必要时改用手工/按序号兜底（驱动已内置序号兜底） |
| `layer_count_not_increased` | 上传后画布图层没涨（片子没贴上去） | 单条重跑；连续失败看 `/api/screenshot` 里当时画面 |
| `intake_has_no_order` | 这条还没绑到订单 | 正常，等真实下单或 `POST /v1/intakes/:id/orders` 模拟 |
| 超时 | 上传/预览慢 | 单条重跑 |

排查时最好用的一张图：`GET /api/screenshot?secret=$SECRET` → 当前浏览器画面（PNG）。

## 四、单条重跑

```bash
# 把状态改回 pending（worker 只处理 pending）
curl -s -XPOST -H "x-api-key: $POD_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"pending"}' https://pod-api.wearhongxiu.com/v1/intakes/<id>/sds
# 只跑这一条
curl -s -XPOST -H "x-worker-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"dryRun":false,"writeBack":true,"intakeId":"<id>"}' .../api/run
```

## 五、状态含义（pod-api）

| status | 含义 |
|---|---|
| `pending` | 已保存拍平输入，还没跟 SDS 交互（`/ops/intakes` 的"待与 SDS 交互"就是它） |
| `cart_added` | 已在 SDS 里复现并加入购物车（`sds` 字段里存了设计器 URL、每片结果、购物车结果、截图路径） |
| `failed` | 尝试过但失败（`error` 有原因） |
| `skipped` | 人工跳过（比如测试用的 fixture） |

## 六、安全

- `/api/*` 有 `x-worker-secret`；noVNC 有 Basic Auth（`VNC_PASSWORD`）。
- noVNC 打开后等于拿到一个已登录 SDS 的浏览器，**不用时切回 headless**（`/api/browser-mode/worker`）。
- 日志不记录 SDS 账号密码；它们只存在容器内的浏览器 profile 卷。
