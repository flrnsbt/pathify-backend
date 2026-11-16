import { DurableObject } from 'cloudflare:workers';
import { Env, processPendingTransactions } from '../index';

/**
 * TransactionScheduler Durable Object
 *
 * Implements an event-driven, self-chaining alarm timer for lazy transaction verification:
 * 1. When a transaction is submitted, the worker calls this DO to schedule a check.
 * 2. When the alarm triggers, it checks on-chain receipts for all pending transactions in Firestore.
 * 3. If any transactions remain in 'pending' status (and are within the
 *    periodic TTL — older ones await a manual refresh), it arms a new alarm.
 * 4. Once all pending transactions are confirmed or resolved, it stops setting alarms and goes
 *    completely dormant (0 CPU cycles, 0 cron wakeups, 0 unnecessary Firestore queries).
 */
export class TransactionScheduler extends DurableObject<Env> {
  private static readonly CHECK_INTERVAL_MS = 20000; // 20 seconds between checks

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/trigger' || url.pathname === '/schedule') {
      let delayMs = TransactionScheduler.CHECK_INTERVAL_MS;
      try {
        const body = (await request.json().catch(() => ({}))) as { delayMs?: number };
        if (typeof body.delayMs === 'number' && body.delayMs >= 0) {
          delayMs = body.delayMs;
        }
      } catch {}

      await this.scheduleNextAlarm(delayMs);

      return new Response(
        JSON.stringify({
          success: true,
          status: 'scheduled',
          delayMs,
          scheduledFor: new Date(Date.now() + delayMs).toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/status') {
      const currentAlarm = await this.ctx.storage.getAlarm();
      return new Response(
        JSON.stringify({
          active: Boolean(currentAlarm),
          nextAlarm: currentAlarm ? new Date(currentAlarm).toISOString() : null,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Arms a single persistent Cloudflare alarm if not already scheduled sooner.
   */
  async scheduleNextAlarm(delayMs: number = TransactionScheduler.CHECK_INTERVAL_MS): Promise<void> {
    const targetTime = Date.now() + delayMs;
    const currentAlarm = await this.ctx.storage.getAlarm();

    // If no alarm is currently set, or the requested targetTime is sooner than the existing one, set it
    if (!currentAlarm || targetTime < currentAlarm) {
      await this.ctx.storage.setAlarm(targetTime);
      console.log(
        `[TransactionScheduler] Armed alarm for ${new Date(targetTime).toISOString()} (in ${Math.round(delayMs / 1000)}s)`
      );
    }
  }

  /**
   * Automatically triggered by Cloudflare's Edge Alarm manager at targetTime.
   */
  async alarm(): Promise<void> {
    console.log('[TransactionScheduler] Alarm fired! Checking pending transactions...');

    try {
      const result = await processPendingTransactions(this.env);
      console.log(
        `[TransactionScheduler] Result: processed ${result.processedCount}, confirmed ${result.confirmedCount}, failed ${result.failedCount}, pending ${result.pendingCount}`
      );

      // Self-chaining check:
      // If there are still pending transactions remaining, arm the next check in 20s
      if (result.pendingCount > 0) {
        console.log(
          `[TransactionScheduler] ${result.pendingCount} transactions still pending. Scheduling next check in 20s...`
        );
        await this.scheduleNextAlarm(TransactionScheduler.CHECK_INTERVAL_MS);
      } else {
        // All transactions are resolved: DO NOT set any alarm!
        console.log(
          '[TransactionScheduler] All pending transactions confirmed or failed. Scheduler is now dormant (0 CPU).'
        );
      }
    } catch (err) {
      console.error('[TransactionScheduler] Error in alarm execution:', err);
      // On temporary network error, retry in 30s
      await this.scheduleNextAlarm(30000);
    }
  }
}
