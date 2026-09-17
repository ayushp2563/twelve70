// src/ml/retrainingScheduler.ts
// ============================================================================
// SCHEDULED ML RETRAINING SERVICE
// ============================================================================
//
// Replaces per-save retraining with a configurable scheduled job.
// Per-save retraining fires on every single user interaction, which:
//   - Wastes CPU when you have thousands of saves/day
//   - Can cause race conditions (two retrains running simultaneously)
//   - Provides diminishing returns (1 new row barely changes the model)
//
// This scheduler:
//   - Runs retraining on a cron schedule (default: every night at 2 AM)
//   - Tracks new interactions since last training (skips if none)
//   - Prevents concurrent retraining with a mutex lock
//   - Provides a manual trigger endpoint for admins
//   - Logs full history of training runs for monitoring
//
// CONFIGURATION (via .env):
//   RETRAIN_CRON       = "0 2 * * *"    (default: 2 AM daily)
//   RETRAIN_ENABLED    = "true"          (default: true)
//   RETRAIN_MIN_NEW    = "10"            (default: 10, min new interactions before retraining)
// ============================================================================

import path from 'path';
import { exec } from 'child_process';
import { getInteractionStore } from '../db';
import { mlRanker } from './inference';

/**
 * Record of a single training run (for monitoring/debugging).
 */
export interface TrainingRun {
  id: number;
  startedAt: string;
  completedAt: string | null;
  trigger: 'scheduled' | 'manual' | 'startup';
  status: 'running' | 'success' | 'failed' | 'skipped';
  newInteractions: number;
  totalInteractions: number;
  durationMs: number | null;
  error: string | null;
}

/**
 * Current status of the retraining scheduler.
 */
export interface SchedulerStatus {
  enabled: boolean;
  cronExpression: string;
  minNewInteractions: number;
  isTraining: boolean;
  lastRun: TrainingRun | null;
  nextScheduledRun: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  interactionsSinceLastTrain: number;
  history: TrainingRun[];
}

export class RetrainingScheduler {
  private cronExpression: string;
  private enabled: boolean;
  private minNewInteractions: number;
  private isTraining: boolean = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private history: TrainingRun[] = [];
  private runCounter: number = 0;
  private interactionsAtLastTrain: number = 0;
  private nextRunTime: Date | null = null;

  constructor() {
    this.cronExpression = process.env.RETRAIN_CRON || '0 2 * * *';
    this.enabled = (process.env.RETRAIN_ENABLED ?? 'true') !== 'false';
    this.minNewInteractions = parseInt(process.env.RETRAIN_MIN_NEW || '10', 10);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Start the cron scheduler.
   * Parses the cron expression and sets up a recurring check.
   */
  start(): void {
    if (!this.enabled) {
      console.log('[Scheduler] ⏸️  Retraining scheduler is DISABLED (RETRAIN_ENABLED=false)');
      return;
    }

    const intervalMs = this.cronToIntervalMs(this.cronExpression);
    this.nextRunTime = new Date(Date.now() + intervalMs);

    console.log(`[Scheduler] ⏰ Retraining scheduler started`);
    console.log(`[Scheduler]    Cron: ${this.cronExpression}`);
    console.log(`[Scheduler]    Interval: ${this.formatDuration(intervalMs)}`);
    console.log(`[Scheduler]    Min new interactions: ${this.minNewInteractions}`);
    console.log(`[Scheduler]    Next run: ~${this.nextRunTime.toLocaleString()}`);

    this.intervalId = setInterval(async () => {
      this.nextRunTime = new Date(Date.now() + intervalMs);
      await this.runTraining('scheduled');
    }, intervalMs);
  }

  /**
   * Stop the scheduler gracefully.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Scheduler] 🛑 Retraining scheduler stopped.');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRAINING EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run a full training cycle:
   *   1. Check if there are enough new interactions
   *   2. Export DB → CSV
   *   3. Run train.py
   *   4. Reload ONNX model
   * 
   * Returns the TrainingRun record.
   */
  async runTraining(trigger: 'scheduled' | 'manual' | 'startup'): Promise<TrainingRun> {
    // Mutex: prevent concurrent runs
    if (this.isTraining) {
      console.log('[Scheduler] ⚠️  Training already in progress, skipping.');
      const skipped = this.createRun(trigger, 'skipped', 0, 0);
      skipped.error = 'Another training run is already in progress';
      skipped.completedAt = new Date().toISOString();
      skipped.durationMs = 0;
      this.history.push(skipped);
      return skipped;
    }

    this.isTraining = true;
    const run = this.createRun(trigger, 'running', 0, 0);
    const startTime = Date.now();

    try {
      // 1. Check if there are enough new interactions
      const store = getInteractionStore();
      const stats = await store.getStats();
      const newInteractions = stats.totalInteractions - this.interactionsAtLastTrain;

      run.totalInteractions = stats.totalInteractions;
      run.newInteractions = newInteractions;

      if (trigger === 'scheduled' && newInteractions < this.minNewInteractions) {
        console.log(`[Scheduler] ⏭️  Only ${newInteractions} new interactions (need ${this.minNewInteractions}). Skipping.`);
        run.status = 'skipped';
        run.error = `Only ${newInteractions} new interactions (minimum: ${this.minNewInteractions})`;
        run.completedAt = new Date().toISOString();
        run.durationMs = Date.now() - startTime;
        this.history.push(run);
        this.isTraining = false;
        return run;
      }

      console.log(`[Scheduler] 🏋️ Starting ${trigger} retraining (${newInteractions} new interactions)...`);

      // 2. Export DB → CSV
      await store.exportForTraining();

      // 3. Run train.py
      await this.executePythonTraining();

      // 4. Reload ONNX model
      await mlRanker.initialize();
      console.log('[Scheduler] 🔄 ONNX model reloaded successfully.');

      // 5. Record success
      run.status = 'success';
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - startTime;
      this.interactionsAtLastTrain = stats.totalInteractions;

      console.log(`[Scheduler] ✅ Retraining complete in ${this.formatDuration(run.durationMs)}.`);
    } catch (err: any) {
      run.status = 'failed';
      run.error = err.message || String(err);
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - startTime;
      console.error(`[Scheduler] ❌ Retraining failed: ${run.error}`);
    } finally {
      this.isTraining = false;
      this.history.push(run);
      // Keep last 50 runs to prevent unbounded memory growth
      if (this.history.length > 50) {
        this.history = this.history.slice(-50);
      }
    }

    return run;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current status of the scheduler + training history.
   */
  async getStatus(): Promise<SchedulerStatus> {
    let interactionsSinceLastTrain = 0;
    try {
      const store = getInteractionStore();
      const stats = await store.getStats();
      interactionsSinceLastTrain = stats.totalInteractions - this.interactionsAtLastTrain;
    } catch {
      // DB might not be available
    }

    return {
      enabled: this.enabled,
      cronExpression: this.cronExpression,
      minNewInteractions: this.minNewInteractions,
      isTraining: this.isTraining,
      lastRun: this.history.length > 0 ? this.history[this.history.length - 1] : null,
      nextScheduledRun: this.nextRunTime?.toISOString() ?? null,
      totalRuns: this.history.length,
      successfulRuns: this.history.filter(r => r.status === 'success').length,
      failedRuns: this.history.filter(r => r.status === 'failed').length,
      interactionsSinceLastTrain,
      history: [...this.history].reverse(), // Most recent first
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private createRun(trigger: TrainingRun['trigger'], status: TrainingRun['status'], newInteractions: number, total: number): TrainingRun {
    return {
      id: ++this.runCounter,
      startedAt: new Date().toISOString(),
      completedAt: null,
      trigger,
      status,
      newInteractions,
      totalInteractions: total,
      durationMs: null,
      error: null,
    };
  }

  /**
   * Execute train.py as a child process. Returns a Promise that resolves on
   * success and rejects on failure.
   */
  private executePythonTraining(): Promise<string> {
    return new Promise((resolve, reject) => {
      const pythonPath = path.join(process.cwd(), 'venv', 'bin', 'python');
      const trainScript = path.join(process.cwd(), 'ml_pipeline', 'train.py');

      exec(`"${pythonPath}" "${trainScript}"`, { timeout: 300_000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`train.py failed: ${error.message}\nStderr: ${stderr}`));
          return;
        }
        console.log(`[Scheduler] train.py output:\n${stdout}`);
        resolve(stdout);
      });
    });
  }

  /**
   * Convert a simple cron expression to an interval in milliseconds.
   * Supports common patterns - for complex cron expressions, you'd use a
   * library like node-cron, but we keep it dependency-free here.
   * 
   * Supported patterns:
   *   "0 2 * * *"     -> daily at 2 AM = 24h interval
   *   "0 * /6 * * *"  -> every 6 hours
   *   "* /30 * * * *"  -> every 30 minutes
   *   "0 0 * * 0"     -> weekly (Sunday midnight) = 7d interval
   *   "0 0 1 * *"     -> monthly (1st at midnight) = 30d interval
   */
  private cronToIntervalMs(cron: string): number {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      console.warn(`[Scheduler] Invalid cron "${cron}", defaulting to 24h.`);
      return 24 * 60 * 60 * 1000;
    }

    const [minute, hour, dayOfMonth, _month, dayOfWeek] = parts;

    // Every N minutes: "*/N * * * *"
    if (minute.startsWith('*/') && hour === '*') {
      const n = parseInt(minute.slice(2), 10);
      return n * 60 * 1000;
    }

    // Every N hours: "0 */N * * *"
    if (hour.startsWith('*/')) {
      const n = parseInt(hour.slice(2), 10);
      return n * 60 * 60 * 1000;
    }

    // Weekly: "X X * * N"
    if (dayOfWeek !== '*' && dayOfMonth === '*') {
      return 7 * 24 * 60 * 60 * 1000;
    }

    // Monthly: "X X N * *"
    if (dayOfMonth !== '*') {
      return 30 * 24 * 60 * 60 * 1000;
    }

    // Daily: "N N * * *" (specific hour and minute, all other wildcards)
    if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && dayOfWeek === '*') {
      return 24 * 60 * 60 * 1000;
    }

    // Hourly: "N * * * *" 
    if (minute !== '*' && hour === '*') {
      return 60 * 60 * 1000;
    }

    // Default: daily
    return 24 * 60 * 60 * 1000;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
}

// Singleton instance
export const retrainingScheduler = new RetrainingScheduler();
