/** pod-api 客户端：取待交互的 intake、取拍平面、回写 SDS 结果 */
const DEFAULT_BASE = 'https://pod-api.wearhongxiu.com';

export class PodApi {
  constructor(options = {}) {
    this.base = String(options.base || process.env.POD_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    this.key = String(options.key || process.env.POD_API_KEY || '');
    this.ua = 'sds-order-worker/0.1 (+pod-api)';
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', 'User-Agent': this.ua, ...extra };
    if (this.key) headers['x-api-key'] = this.key;
    return headers;
  }

  async request(path, options = {}) {
    const response = await fetch(this.base + path, { ...options, headers: this.headers(options.headers) });
    const text = await response.text();
    if (!response.ok) throw new Error(`pod_api_${response.status}:${path}:${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** 待与 SDS 交互的输入；默认只要「已经产生购买（绑定过订单）」的 */
  async pendingIntakes({ limit = 20, includeUnordered = false } = {}) {
    const list = await this.request(`/v1/intakes?status=pending&limit=${encodeURIComponent(limit)}`);
    const items = list?.items ?? [];
    const detailed = [];
    for (const item of items) {
      const detail = await this.getIntake(item.id);
      if (!detail) continue;
      if (!includeUnordered && !(detail.orders ?? []).length) continue;
      detailed.push(detail);
    }
    return detailed;
  }

  getIntake(id) {
    return this.request(`/v1/intakes/${encodeURIComponent(id)}`).catch(() => null);
  }

  sideUrl(intakeId, sideId) {
    return `${this.base}/v1/intakes/${encodeURIComponent(intakeId)}/sides/${encodeURIComponent(sideId)}.png`;
  }

  async sideBytes(intakeId, sideId) {
    const response = await fetch(this.sideUrl(intakeId, sideId), { headers: this.headers() });
    if (!response.ok) throw new Error(`side_fetch_${response.status}:${sideId}`);
    return Buffer.from(await response.arrayBuffer());
  }

  manifest(productId) {
    return this.request(`/v1/products/${encodeURIComponent(productId)}/manifest`);
  }

  /** worker 回写：cart_added / failed */
  reportSds(intakeId, { status, sds, error }) {
    return this.request(`/v1/intakes/${encodeURIComponent(intakeId)}/sds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, sds, error: error ?? null })
    });
  }

  /** 把订单行按 尺码 -> 件数 汇总（同一尺码合并） */
  static cartLines(intake) {
    const bySize = new Map();
    for (const order of intake.orders ?? []) {
      const size = String(order.size ?? '').trim() || 'M';
      bySize.set(size, (bySize.get(size) ?? 0) + (Number(order.quantity) || 0));
    }
    if (!bySize.size) bySize.set('M', 1);
    return [...bySize.entries()].map(([size, quantity]) => ({ size, quantity: Math.max(1, quantity) }));
  }
}
