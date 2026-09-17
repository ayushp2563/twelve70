import express, { Request, Response } from 'express';
import path from 'path';
import { pool } from '../config/database';
import { matchTopOuterColor, OutfitInput } from '../colorMatcher';
import { engine } from '../sequentialFilter';
import { mlRanker } from '../ml/inference';
import { flagger } from '../flaggingSystem';
import { getInteractionStore } from '../db';
import { retrainingScheduler } from '../ml/retrainingScheduler';
import { profileRollupScheduler } from '../ml/profileRollupScheduler';
import { UserProfile } from '../db/types';

// Small TTL cache so predictions don't hit MySQL for the profile on every
// request. Entries expire after 5 minutes; null is cached too (no history).
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const profileCache = new Map<string, { profile: UserProfile | null; expiresAt: number }>();

async function getCachedUserProfile(userId: string): Promise<UserProfile | null> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  try {
    const profile = await getInteractionStore().getUserProfile(userId);
    profileCache.set(userId, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return profile;
  } catch {
    // DB unavailable — predictions must still work without personalization
    return null;
  }
}

export function setupColorMatchingEndpoint(app: express.Application): void {

  // ══════════════════════════════════════════════════════════════════════════
  // SEQUENTIAL FILTER ROUTES  (CSV-based, no DB required)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/outfit/step/tops
   * Returns all distinct top colours with frequency counts.
   */
  app.get('/api/outfit/step/tops', (_req: Request, res: Response) => {
    try {
      const options = engine.getAllTopColors();
      res.json({ success: true, step: 'top', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/outfit/step/bottom?topColor=black&occasion=formal&vibe=minimalist&fitType=fitted
   * Returns ranked bottom-colour options given the chosen top.
   */
  app.get('/api/outfit/step/bottom', (req: Request, res: Response) => {
    const { topColor, occasion, vibe, fitType } = req.query as Record<string, string>;
    if (!topColor) return res.status(400).json({ success: false, error: 'topColor is required' });
    try {
      const filters = { occasion, vibe, fitType };
      const options = engine.getBottomOptions(topColor, filters);
      res.json({ success: true, step: 'bottom', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/outfit/step/outerwear?topColor=black&bottomColor=darkdenim&occasion=formal
   * Returns ranked outerwear options given top + bottom.
   */
  app.get('/api/outfit/step/outerwear', (req: Request, res: Response) => {
    const { topColor, bottomColor, occasion, vibe, fitType } = req.query as Record<string, string>;
    if (!topColor || !bottomColor)
      return res.status(400).json({ success: false, error: 'topColor and bottomColor are required' });
    try {
      const filters = { occasion, vibe, fitType };
      const options = engine.getOuterwearOptions(topColor, bottomColor, filters);
      res.json({ success: true, step: 'outerwear', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/outfit/step/footwear?topColor=black&bottomColor=darkdenim&outerwearColor=greycamo&occasion=casual
   * Returns ranked footwear options given top + bottom + outerwear.
   */
  app.get('/api/outfit/step/footwear', (req: Request, res: Response) => {
    const { topColor, bottomColor, outerwearColor, occasion, vibe, fitType } = req.query as Record<string, string>;
    if (!topColor || !bottomColor || !outerwearColor)
      return res.status(400).json({ success: false, error: 'topColor, bottomColor, outerwearColor are required' });
    try {
      const filters = { occasion, vibe, fitType };
      const options = engine.getFootwearOptions(topColor, bottomColor, outerwearColor, filters);
      res.json({ success: true, step: 'footwear', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * POST /api/outfit/predict-outer
   * Body: { topColor, bottomColor, outerwearColor, footwearColor, occasion, vibe, fitType }
   * Returns predicted top_outer_color with alternatives and score breakdown.
   */
  app.post('/api/outfit/predict-outer', async (req: Request, res: Response) => {
    const { topColor, bottomColor, outerwearColor, footwearColor, occasion, vibe, fitType, userId } = req.body;
    if (!topColor || !bottomColor || !outerwearColor || !footwearColor)
      return res.status(400).json({ success: false, error: 'All four garment colors are required' });
    try {
      const startTime = Date.now();
      const filters = { occasion, vibe, fitType };
      const result = engine.predictTopOuter(topColor, bottomColor, outerwearColor, footwearColor, filters);

      // Personalization context: the user's rolled-up color affinity profile
      const profile = userId ? await getCachedUserProfile(userId) : null;

      // Apply ML Re-Ranking
      if (mlRanker.isEnabled()) {
        const allCandidates = [result.primary, ...result.alternatives].filter(Boolean);
        const reRanked = await mlRanker.reRankCandidates(
          allCandidates,
          { topColor, bottomColor, outerwearColor, footwearColor, userId, colorAffinity: profile?.colorAffinity },
          'topOuterColor'
        );
        if (reRanked.length > 0) {
          result.primary = reRanked[0];
          result.alternatives = reRanked.slice(1);
        }
      }

      res.json({
        success: true,
        data: result,
        meta: { responseTime: `${Date.now() - startTime}ms` },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LEGACY / EXISTING ROUTES (unchanged)
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/outfit/suggest-outer-color', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const outfit: OutfitInput = req.body;
      if (!outfit.topColor || !outfit.bottomColor || !outfit.outerwearColor || !outfit.footwearColor) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }
      const result = await matchTopOuterColor(outfit, pool);
      res.json({ success: true, data: result, metadata: { responseTime: `${Date.now() - startTime}ms` } });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to generate recommendation' });
    }
  });

  app.get('/api/admin/stats', async (_req: Request, res: Response) => {
    try {
      const [colorRows]: any = await pool.query('SELECT COUNT(*) as count FROM colors');
      const [comboRows]: any = await pool.query('SELECT COUNT(*) as count FROM color_combos');
      res.json({ success: true, totalColors: colorRows[0].count, totalCombos: comboRows[0].count });
    } catch {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  app.get('/api/admin/combos', async (req: Request, res: Response) => {
    try {
      const { outerwear, top } = req.query;
      let sql = 'SELECT * FROM color_combos WHERE 1=1';
      const params: any[] = [];
      if (outerwear) { sql += ' AND outerwear_color LIKE ?'; params.push(`%${outerwear}%`); }
      if (top)       { sql += ' AND top_color LIKE ?';       params.push(`%${top}%`); }
      sql += ' ORDER BY created_at DESC LIMIT 50';
      const [rows] = await pool.query(sql, params);
      res.json({ success: true, combos: rows });
    } catch {
      res.status(500).json({ error: 'Failed to fetch combos' });
    }
  });

  app.post('/api/admin/combos', async (req: Request, res: Response) => {
    try {
      const { topColor, bottomColor, outerwearColor, footwearColor, topOuterColor } = req.body;
      const id = require('crypto').randomUUID();
      await pool.query(
        `INSERT INTO color_combos (id,top_color,bottom_color,outerwear_color,footwear_color,top_outer_color,is_active,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,NOW(),NOW())`,
        [id, topColor, bottomColor, outerwearColor, footwearColor, topOuterColor]
      );
      res.json({ success: true, id });
    } catch (error) {
      res.status(500).json({ error: 'Failed to add combo' });
    }
  });

  app.get('/api/outfit/colors', async (_req: Request, res: Response) => {
    try {
      const [colors] = await pool.query('SELECT id, name, hexcode FROM colors ORDER BY name ASC');
      res.json({ success: true, data: colors });
    } catch {
      res.status(500).json({ success: false, error: 'Failed to fetch colors' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL FLAGGING SYSTEM ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/outfit/flag', async (req: Request, res: Response) => {
    try {
      const { topColor, bottomColor, outerwearColor, footwearColor, topOuterColor, reason } = req.body;
      const flagged = await flagger.addFlag({
        topColor,
        bottomColor,
        outerwearColor,
        footwearColor,
        topOuterColor,
        reason
      });
      res.json({ success: true, flagged });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.get('/api/outfit/flagged', async (_req: Request, res: Response) => {
    try {
      const flags = await flagger.getFlags();
      res.json({ success: true, flags });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FEEDBACK LOOP ROUTE (Saves to DB — retraining runs on cron schedule)
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/outfit/save', async (req: Request, res: Response) => {
    const { userId, topColor, bottomColor, outerwearColor, footwearColor, topOuterColor, interactionScore, vibe, occasion, fitType, confidenceScore, modelVersion } = req.body;
    if (!topColor || !bottomColor || !outerwearColor || !footwearColor || !topOuterColor) {
      return res.status(400).json({ success: false, error: 'All garment colors are required' });
    }

    try {
      const store = getInteractionStore();

      // Normalize colors
      const normTop = topColor.trim().toLowerCase();
      const normBottom = bottomColor.trim().toLowerCase();
      const normOuter = outerwearColor.trim().toLowerCase();
      const normFoot = footwearColor.trim().toLowerCase();
      const normTopOuter = topOuterColor.trim().toLowerCase();
      const score = typeof interactionScore === 'number' ? interactionScore : 2;

      // Save to database (retraining happens on scheduled cron, not per-save)
      const saved = await store.saveInteraction({
        userId: userId || 'anonymous',
        action: 'save',
        topColor: normTop,
        bottomColor: normBottom,
        outerwearColor: normOuter,
        footwearColor: normFoot,
        topOuterColor: normTopOuter,
        interactionScore: score,
        confidenceScore: confidenceScore ?? undefined,
        modelVersion: modelVersion ?? undefined,
        vibe: vibe ?? undefined,
        occasion: occasion ?? undefined,
        fitType: fitType ?? undefined,
      });

      console.log(`💾 Saved interaction #${saved.id} for user "${saved.userId}" -> ${normTopOuter}`);

      res.json({ success: true, interactionId: saved.id, userId: saved.userId });
    } catch (err) {
      console.error('❌ Failed to save interaction:', err);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // INTERACTION MONITORING ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/interactions/stats
   * Returns summary statistics: total interactions, saves, flags, unique users.
   */
  app.get('/api/interactions/stats', async (_req: Request, res: Response) => {
    try {
      const store = getInteractionStore();
      const stats = await store.getStats();
      res.json({ success: true, stats });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/interactions/user/:userId
   * Returns all interactions for a specific user.
   * Query params: ?limit=50
   */
  app.get('/api/interactions/user/:userId', async (req: Request, res: Response) => {
    try {
      const userId = req.params.userId as string;
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const store = getInteractionStore();
      const interactions = await store.getInteractionsByUser(userId, limit);
      res.json({ success: true, userId, count: interactions.length, interactions });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/users/:userId/profile
   * Returns the user's merged profile: color affinities, favorite colors,
   * and context preferences (from monthly summaries + live interactions).
   */
  app.get('/api/users/:userId/profile', async (req: Request, res: Response) => {
    try {
      const userId = req.params.userId as string;
      const store = getInteractionStore();
      const profile = await store.getUserProfile(userId);
      if (!profile) {
        return res.status(404).json({ success: false, error: `No history found for user: ${userId}` });
      }
      res.json({ success: true, profile });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * DELETE /api/interactions/user/:userId
   * Deletes all interactions for a specific user (GDPR compliance).
   */
  app.delete('/api/interactions/user/:userId', async (req: Request, res: Response) => {
    try {
      const userId = req.params.userId as string;
      const store = getInteractionStore();
      const deletedCount = await store.deleteUserInteractions(userId);
      res.json({ success: true, userId, deletedCount });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETRAINING SCHEDULER ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/admin/retraining/status
   * Returns scheduler status, config, and training run history.
   */
  console.log("REGISTERING STATUS ROUTE!!"); app.get('/api/admin/retraining/status', async (_req: Request, res: Response) => {
    try {
      const status = await retrainingScheduler.getStatus();
      res.json({ success: true, ...status });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * POST /api/admin/retraining/trigger
   * Manually trigger a retraining run (bypasses the min interaction check).
   */
  app.post('/api/admin/retraining/trigger', async (_req: Request, res: Response) => {
    try {
      const run = await retrainingScheduler.runTraining('manual');
      res.json({ success: true, run });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE ROLLUP ENDPOINTS (summarize + archive + prune old interactions)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/admin/rollup/status
   * Returns the rollup scheduler config, state, and run history.
   */
  app.get('/api/admin/rollup/status', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, ...profileRollupScheduler.getStatus() });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * POST /api/admin/rollup/trigger
   * Manually run one rollup cycle (summarize, archive, prune old rows).
   */
  app.post('/api/admin/rollup/trigger', async (_req: Request, res: Response) => {
    try {
      const run = await profileRollupScheduler.runRollup('manual');
      res.json({ success: true, run });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
}