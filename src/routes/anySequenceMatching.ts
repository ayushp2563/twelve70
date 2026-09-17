import express, { Request, Response } from 'express';
import { anySequenceEngine, AnySequenceContext } from '../anySequenceFilter';
import { mlRanker } from '../ml/inference';

/**
 * Any-Sequence / Freeform Route Definitions
 * Mounted at /api/any-sequence/*
 */
export function setupAnySequenceRoutes(app: express.Application): void {
  
  /**
   * POST /api/any-sequence/options
   * Body: { selections: { topColor?: string, bottomColor?: string, outerwearColor?: string, footwearColor?: string, topOuterColor?: string } }
   * Returns ranked options for ALL categories simultaneously, dynamically scored
   * against the currently selected items.
   */
  app.post('/api/any-sequence/options', async (req: Request, res: Response) => {
    try {
      const selections: AnySequenceContext = req.body.selections || {};
      const { occasion, vibe, fitType } = req.body;
      const filters = { occasion, vibe, fitType };
      const options = anySequenceEngine.getOptionsForAnySequence(selections, filters);

      // Apply ML Re-Ranking dynamically to all category option pools
      if (mlRanker.isEnabled()) {
        const slots = ['topColor', 'bottomColor', 'outerwearColor', 'footwearColor', 'topOuterColor'];
        for (const slot of slots) {
          if (options[slot] && options[slot].length > 0) {
            options[slot] = await mlRanker.reRankCandidates(
              options[slot],
              selections,
              slot
            );
          }
        }
      }

      res.json({
        success: true,
        options
      });
    } catch (err) {
      console.error('Error in /api/any-sequence/options:', err);
      res.status(500).json({
        success: false,
        error: String(err)
      });
    }
  });
}
