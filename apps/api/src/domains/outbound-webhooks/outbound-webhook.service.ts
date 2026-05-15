/**
 * Outbound webhook delivery.
 *
 * Subscribers register a URL + event-type list + a shared secret. When an
 * internal event fires (e.g. revenue.event), we fan out to every subscription
 * matching the event type by enqueueing a WebhookDelivery row per subscriber.
 *
 * The worker signs the body with HMAC-SHA-256 (same shape as our inbound
 * verification) and POSTs. Non-2xx → BullMQ exponential retry. After 6 attempts
 * the delivery is marked ABANDONED and an audit row is written.
 */
import { createHash, createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import { WebhookDeliveryStatus, type PrismaClient, type WebhookSubscription } from '@prisma/client';
import { enqueueWebhookDelivery } from '../../shared/queues/webhook-delivery.queue.js';

/**
 * SEC-110 — SSRF guard for outbound delivery.
 *
 * Subscribers can register any URL they like; before we `fetch` it, the
 * worker resolves the hostname and rejects any IP in:
 *   - RFC 1918 private space (10/8, 172.16/12, 192.168/16)
 *   - Loopback (127/8, ::1)
 *   - Link-local (169.254/16, including AWS metadata 169.254.169.254)
 *   - Carrier-grade NAT (100.64/10)
 *   - Multicast / reserved
 *   - IPv6 unique-local (fc00::/7)
 *
 * Without this gate, a malicious or compromised user account can register
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and
 * harvest AWS metadata into `lastResponseBody`, or probe internal services
 * via the worker's network position. Classic SOC 2 CC6.6 fail.
 *
 * We also disable redirects (a 302 to a private IP would defeat the
 * pre-flight check) and rate-limit response size at read time.
 */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true; // unparseable → fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes AWS metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // ::ffff:a.b.c.d — IPv4-mapped — extract and check the v4 portion
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  // fc00::/7 — unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // ff00::/8 — multicast
  if (lower.startsWith('ff')) return true;
  return false;
}

export async function assertPublicHostname(urlString: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('webhook.url.invalid');
  }
  // Only HTTPS in production. http:// is fine for local dev / mock servers.
  if (process.env['NODE_ENV'] === 'production' && url.protocol !== 'https:') {
    throw new Error('webhook.url.https_required');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('webhook.url.scheme_not_allowed');
  }
  const host = url.hostname;
  // If the literal hostname IS an IP address, gate it directly.
  if (net.isIP(host)) {
    const isPrivate = net.isIPv6(host) ? isPrivateIPv6(host) : isPrivateIPv4(host);
    if (isPrivate) throw new Error('webhook.url.private_address');
    return;
  }
  // DNS-resolve and check every returned address. Use `all: true` so we
  // don't get tricked by a multi-A-record host where one entry is public
  // and another is RFC1918.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error('webhook.url.dns_failed');
  }
  if (records.length === 0) throw new Error('webhook.url.dns_empty');
  for (const r of records) {
    const isPrivate = r.family === 6 ? isPrivateIPv6(r.address) : isPrivateIPv4(r.address);
    if (isPrivate) throw new Error('webhook.url.private_address');
  }
}

export class OutboundWebhookService {
  constructor(private readonly prisma: PrismaClient) {}

  static hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Fan out an event to every active subscription that wants this event type.
   * Returns the number of deliveries scheduled.
   *
   * Phase 1 retrofit (GAP-115): the dispatch is org-scoped. Subscribers
   * only receive events that belong to their tenant. The caller must
   * supply `orgId`; producers of the event know which tenant it belongs
   * to (e.g. webhook signature verification resolves it from the
   * WebhookCredential row that matched). Previously dispatch fanned out
   * to every matching subscription across all tenants — a wire-level
   * cross-tenant data leak by design.
   */
  async dispatch(orgId: string, eventType: string, payload: unknown): Promise<number> {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: { orgId, isActive: true, eventTypes: { has: eventType } },
    });
    if (subs.length === 0) return 0;
    let count = 0;
    for (const sub of subs) {
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          id: uuidv7(),
          orgId: sub.orgId,
          subscriptionId: sub.id,
          eventType,
          payload: payload as object,
        },
      });
      await enqueueWebhookDelivery({ deliveryId: delivery.id });
      count += 1;
    }
    return count;
  }

  /**
   * Worker entry. Pulls the delivery row, signs and POSTs, updates status.
   * Throws on non-2xx so BullMQ schedules a retry.
   */
  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { subscription: true },
    });
    if (!delivery) throw new Error(`Delivery ${deliveryId} not found`);
    if (delivery.status === WebhookDeliveryStatus.SUCCESS) return;

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.RETRYING,
        attemptCount: delivery.attemptCount + 1,
      },
    });

    try {
      const { status, error } = await this.send(
        delivery.subscription,
        delivery.eventType,
        delivery.payload,
      );
      if (status >= 200 && status < 300) {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.SUCCESS,
            lastResponseCode: status,
            deliveredAt: new Date(),
          },
        });
      } else {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.FAILED,
            lastResponseCode: status,
            lastError: error ?? `HTTP ${status}`,
          },
        });
        throw new Error(`Subscriber returned ${status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: WebhookDeliveryStatus.FAILED, lastError: msg },
      });
      throw err;
    }
  }

  private async send(
    sub: WebhookSubscription,
    eventType: string,
    payload: unknown,
  ): Promise<{ status: number; error?: string }> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ eventType, payload, deliveredAt: new Date().toISOString() });
    // Sign with the original secret. We only stored the hash, so we use the
    // hash itself as the signing key — subscribers should also know the
    // original secret to verify, but since we can't recover it, we expose
    // the hashed-secret out-of-band for verification. (Improvement: store
    // encrypted secret instead of hash, so subscribers verify against original.)
    const signature = createHmac('sha256', sub.secretHash).update(`${ts}.${body}`).digest('hex');
    try {
      // SEC-110: pre-flight SSRF guard. Resolves the hostname and rejects
      // RFC1918 / loopback / link-local / metadata addresses BEFORE the
      // fetch call constructs a connection. `redirect: 'manual'` ensures a
      // 302 to a private IP cannot defeat the guard — the worker never
      // follows the redirect and the delivery is recorded as the original
      // upstream's status.
      await assertPublicHostname(sub.url);
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eazepay-Signature': signature,
          'X-Eazepay-Timestamp': ts,
          'X-Eazepay-Event-Type': eventType,
          'User-Agent': 'eazepay-intelligence/0.1',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 0, error: msg };
    }
  }
}
