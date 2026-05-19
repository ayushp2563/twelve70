import express, { Request, Response } from 'express';
import path from 'path';
import { pool } from '../config/database';
import { matchTopOuterColor, OutfitInput } from '../colorMatcher';
import { engine } from '../sequentialFilter';

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
   * GET /api/outfit/step/bottom?topColor=black
   * Returns ranked bottom-colour options given the chosen top.
   */
  app.get('/api/outfit/step/bottom', (req: Request, res: Response) => {
    const { topColor } = req.query as Record<string, string>;
    if (!topColor) return res.status(400).json({ success: false, error: 'topColor is required' });
    try {
      const options = engine.getBottomOptions(topColor);
      res.json({ success: true, step: 'bottom', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/outfit/step/outerwear?topColor=black&bottomColor=darkdenim
   * Returns ranked outerwear options given top + bottom.
   */
  app.get('/api/outfit/step/outerwear', (req: Request, res: Response) => {
    const { topColor, bottomColor } = req.query as Record<string, string>;
    if (!topColor || !bottomColor)
      return res.status(400).json({ success: false, error: 'topColor and bottomColor are required' });
    try {
      const options = engine.getOuterwearOptions(topColor, bottomColor);
      res.json({ success: true, step: 'outerwear', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/outfit/step/footwear?topColor=black&bottomColor=darkdenim&outerwearColor=greycamo
   * Returns ranked footwear options given top + bottom + outerwear.
   */
  app.get('/api/outfit/step/footwear', (req: Request, res: Response) => {
    const { topColor, bottomColor, outerwearColor } = req.query as Record<string, string>;
    if (!topColor || !bottomColor || !outerwearColor)
      return res.status(400).json({ success: false, error: 'topColor, bottomColor, outerwearColor are required' });
    try {
      const options = engine.getFootwearOptions(topColor, bottomColor, outerwearColor);
      res.json({ success: true, step: 'footwear', options });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  /**
   * POST /api/outfit/predict-outer
   * Body: { topColor, bottomColor, outerwearColor, footwearColor }
   * Returns predicted top_outer_color with alternatives and score breakdown.
   */
  app.post('/api/outfit/predict-outer', (req: Request, res: Response) => {
    const { topColor, bottomColor, outerwearColor, footwearColor } = req.body;
    if (!topColor || !bottomColor || !outerwearColor || !footwearColor)
      return res.status(400).json({ success: false, error: 'All four garment colors are required' });
    try {
      const startTime = Date.now();
      const result = engine.predictTopOuter(topColor, bottomColor, outerwearColor, footwearColor);
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
}