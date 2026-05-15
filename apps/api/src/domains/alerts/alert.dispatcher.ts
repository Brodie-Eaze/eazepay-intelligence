/**
 * Alert notification dispatcher.
 *
 * On a state-transition INTO `OPEN`, dispatch the alert payload to the
 * rule's NotificationChannel. We intentionally keep the side-effect surface
 * narrow: each channel kind is a thin function whose only job is "send."
 * The retry / backoff / dead-letter contract belongs to the caller (the
 * worker) and the existing OutboundWebhookService for the WEBHOOK kind.
 *
 * Why not enqueue every dispatch on BullMQ? For the WEBHOOK kind we
 * absolutely should — it has retry semantics, signature, audit. For
 * EMAIL/SLACK/IN_APP we'd want similar workers when those integrations
 * land. Right now the integrations are stubbed at the I/O boundary; we
 * record the dispatch in the audit log and the operator UI surfaces the
 * Alert row regardless of whether external delivery succeeds.
 *
 * SOC 2 mapping:
 *   - CC4.1 — alerts evaluated, dispatched, and audited
 *   - CC7.3 — every dispatch attempt + result captured in audit_logs
 */
import type { PrismaClient, Alert, NotificationChannel } from '@prisma/client';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { getLogger } from '../../config/logger.js';

export interface DispatchResult {
  channelId: string | null;
  channelKind: string | null;
  delivered: boolean;
  reason?: string;
}

export class AlertDispatcher {
  constructor(private readonly prisma: PrismaClient) {}

  async dispatch(alert: Alert, channel: NotificationChannel | null): Promise<DispatchResult> {
    const log = getLogger();
    if (!channel) {
      log.warn({ alertId: alert.id, ruleId: alert.ruleId }, 'alert.dispatch.no_channel');
      await writeAuditLog({
        action: 'ALERT_FIRED',
        resourceType: 'alert',
        resourceId: alert.id,
        metadata: {
          ruleId: alert.ruleId,
          severity: alert.severity,
          dispatched: false,
          reason: 'no_channel',
        },
      });
      return { channelId: null, channelKind: null, delivered: false, reason: 'no_channel' };
    }

    if (!channel.isActive) {
      await writeAuditLog({
        action: 'ALERT_FIRED',
        resourceType: 'alert',
        resourceId: alert.id,
        metadata: {
          ruleId: alert.ruleId,
          channelId: channel.id,
          dispatched: false,
          reason: 'channel_inactive',
        },
      });
      return {
        channelId: channel.id,
        channelKind: channel.kind,
        delivered: false,
        reason: 'channel_inactive',
      };
    }

    let delivered = false;
    let reason: string | undefined;
    try {
      switch (channel.kind) {
        case 'IN_APP':
          // The Alert row itself IS the in-app surface; dispatch is a no-op.
          delivered = true;
          break;
        case 'WEBHOOK':
          // Real delivery (HMAC-signed, retried) will be owned by
          // OutboundWebhookService. Until the OUTBOUND_DELIVERY job is
          // enqueued from here, treat WEBHOOK as undelivered with an
          // explicit reason — never silently succeed. Monitoring on
          // reason='webhook_dispatch_not_implemented' surfaces the gap
          // immediately rather than after a compliance audit.
          delivered = false;
          reason = 'webhook_dispatch_not_implemented';
          break;
        case 'EMAIL':
        case 'SLACK':
          // Stubs at the I/O boundary — vendor integrations land in v1.1.
          // The Alert row is durable; ops can query alerts WHERE state=OPEN
          // without depending on email/slack delivery.
          delivered = false;
          reason = 'integration_pending';
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ alertId: alert.id, channelId: channel.id, err: msg }, 'alert.dispatch.error');
      delivered = false;
      reason = msg.slice(0, 200);
    }

    await writeAuditLog({
      action: 'ALERT_FIRED',
      resourceType: 'alert',
      resourceId: alert.id,
      metadata: {
        ruleId: alert.ruleId,
        channelId: channel.id,
        channelKind: channel.kind,
        severity: alert.severity,
        dispatched: delivered,
        ...(reason ? { reason } : {}),
      },
    });

    return {
      channelId: channel.id,
      channelKind: channel.kind,
      delivered,
      ...(reason ? { reason } : {}),
    };
  }
}
