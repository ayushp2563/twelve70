// src/ml/profileRollupScheduler.ts
// ============================================================================
// SCHEDULED USER-PROFILE ROLLUP SERVICE
// ============================================================================
//
// Keeps the hot `user_interactions` table small without losing information:
//   1. SUMMARIZE — merge each user's old clicks into compact per-month
//      counts in `user_profile_summaries` (used for personalization).
//   2. ARCHIVE   — append the raw rows to data/archive/interactions_YYYY-MM.csv
//      so ML retraining keeps the FULL history (exportForTraining merges
//      archives back in automatically).
//   3. PRUNE     — delete the archived rows from the hot table.
//
// The check runs daily, but only rows older than the retention window are
// touched — so every interaction lives in the hot table for ~30 days, then
// moves to summary + archive. Small daily batches beat one giant monthly
// job: bounded memory, bounded transactions, no monthly load spike.
//
// CONFIGURATION (via .env):
//   PROFILE_ROLLUP_ENABLED  = "true"   (default: true)
//   PROFILE_RETENTION_DAYS  = "30"     (default: 30, hot-table retention)
//   PROFILE_ROLLUP_HOURS    = "24"     (default: 24, check interval)
// ============================================================================

import path from 'path';
import { getInteractionStore } from '../db';
import { RollupResult } from '../db/types';

export interface RollupRun {
  id: number;
  startedAt: string;
  completedAt: string | null;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'success' | 'failed' | 'skipped';
  result: RollupResult | null;
  error: string | null;
}

export interface RollupSchedulerStatus {
  enabled: boolean;
  retentionDays: number;
  checkIntervalHours: number;
  isRunning: boolean;
  nextScheduledRun: string | null;
  lastRun: RollupRun | null;
  history: RollupRun[];
}

export class ProfileRollupScheduler {
  private enabled: boolean;
  private retentionDays: number;
  private checkIntervalMs: number;
  private isRunning = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private history: RollupRun[] = [];
  private runCounter = 0;
  private nextRunTime: Date | null = null;

  constructor() {
    this.enabled = (process.env.PROFILE_ROLLUP_ENABLED ?? 'true') !== 'false';
    this.retentionDays = parseInt(process.env.PROFILE_RETENTION_DAYS || '30', 10);
    const hours = parseFloat(process.env.PROFILE_ROLLUP_HOURS || '24');
    this.checkIntervalMs = Math.max(hours, 0.1) * 60 * 60 * 1000;
  }

  start(): void {
    if (!this.enabled) {
      console.log('[Rollup] ⏸️  Profile rollup scheduler is DISABLED (PROFILE_ROLLUP_ENABLED=false)');
      return;
    }

    this.nextRunTime = new Date(Date.now() + this.checkIntervalMs);
    console.log('[Rollup] 🗂️  Profile rollup scheduler started');
    console.log(`[Rollup]    Retention: ${this.retentionDays} days in hot table`);
    console.log(`[Rollup]    Check interval: ${(this.checkIntervalMs / 3_600_000).toFixed(1)}h`);
    console.log(`[Rollup]    Next run: ~${this.nextRunTime.toLocaleString()}`);

    this.intervalId = setInterval(async () => {
      this.nextRunTime = new Date(Date.now() + this.checkIntervalMs);
      await this.runRollup('scheduled');
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Rollup] 🛑 Profile rollup scheduler stopped.');
    }
  }

  /**
   * Run one rollup cycle: summarize + archive + prune everything older
   * than the retention window.
   */
  async runRollup(trigger: 'scheduled' | 'manual'): Promise<RollupRun> {
    const run: RollupRun = {
      id: ++this.runCounter,
      startedAt: new Date().toISOString(),
      completedAt: null,
      trigger,
      status: 'running',
      result: null,
      error: null,
    };

    if (this.isRunning) {
      run.status = 'skipped';
      run.error = 'Another rollup is already in progress';
      run.completedAt = new Date().toISOString();
      this.pushHistory(run);
      return run;
    }

    this.isRunning = true;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
      const cutoffIso = cutoff.toISOString().slice(0, 19).replace('T', ' ');
      const archiveDir = path.join(process.cwd(), 'data', 'archive');

      const store = getInteractionStore();
      const result = await store.rollupOldInteractions(cutoffIso, archiveDir);

      run.result = result;
      run.status = 'success';
      if (result.rowsExamined === 0) {
        console.log(`[Rollup] ⏭️  No interactions older than ${this.retentionDays} days. Nothing to do.`);
      }
    } catch (err: any) {
      run.status = 'failed';
      run.error = err.message || String(err);
      console.error(`[Rollup] ❌ Rollup failed: ${run.error}`);
    } finally {
      run.completedAt = new Date().toISOString();
      this.isRunning = false;
      this.pushHistory(run);
    }

    return run;
  }

  getStatus(): RollupSchedulerStatus {
    return {
      enabled: this.enabled,
      retentionDays: this.retentionDays,
      checkIntervalHours: this.checkIntervalMs / 3_600_000,
      isRunning: this.isRunning,
      nextScheduledRun: this.nextRunTime?.toISOString() ?? null,
      lastRun: this.history.length > 0 ? this.history[this.history.length - 1] : null,
      history: [...this.history].reverse(),
    };
  }

  private pushHistory(run: RollupRun): void {
    this.history.push(run);
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }
  }
}

// Singleton instance
export const profileRollupScheduler = new ProfileRollupScheduler();
