import { describe, test, expect, beforeAll } from '@jest/globals';
import { getMetadataTags, getSeasonalBoost, calculateTrendScore, areHarmoniousPatterns, getFamily, ColorFamily, isDarkColor, engine } from '../sequentialFilter';
import { scoreGarmentForAnySequence, anySequenceEngine } from '../anySequenceFilter';
import path from 'path';

describe('Advanced Scoring, Seasonality, Trending, Patterns and Filtering Logic', () => {
  beforeAll(async () => {
    const projectRoot = path.join(__dirname, '..', '..');
    await engine.initialize(projectRoot);
    await anySequenceEngine.initialize(projectRoot);
  });


  test('Occasion, vibe, and fit type metadata tagging rules', () => {
    // Formal occasions
    const blackMeta = getMetadataTags('black');
    expect(blackMeta.occasions).toContain('formal');
    expect(blackMeta.occasions).toContain('casual');
    expect(blackMeta.vibe).toBe('minimalist');
    expect(blackMeta.fitType).toBe('fitted');

    // Athletic/casual occasions
    const marledMeta = getMetadataTags('marled_grey');
    expect(marledMeta.occasions).toContain('athletic');
    expect(marledMeta.vibe).toBe('minimalist');
    expect(marledMeta.fitType).toBe('oversized');

    // Pattern vibes
    const plaidMeta = getMetadataTags('red_plaid');
    expect(plaidMeta.vibe).toBe('maximalist');
    expect(plaidMeta.fitType).toBe('oversized');
  });

  test('Seasonality boost scoring rules (Winter/Summer)', () => {
    const month = new Date().getMonth();
    const blackBoost = getSeasonalBoost('black');
    const whiteBoost = getSeasonalBoost('white');

    if (month === 11 || month === 0 || month === 1) { // Winter
      expect(blackBoost.boost).toBe(5);
      expect(blackBoost.season).toBe('Winter');
      expect(whiteBoost.boost).toBe(0);
    } else if (month === 5 || month === 6 || month === 7) { // Summer
      expect(whiteBoost.boost).toBe(5);
      expect(whiteBoost.season).toBe('Summer');
      expect(blackBoost.boost).toBe(0);
    } else { // Spring/Fall
      expect(blackBoost.boost).toBe(0);
      expect(whiteBoost.boost).toBe(0);
    }
  });

  test('Trending saves boost with decay simulation', () => {
    // 'black + camel + charcoal' should be trending
    const selections = {
      topColor: 'black',
      charcoal: 'charcoal'
    };
    // If selections contains 'black', then 'camel' completes the trending combo
    const trend = calculateTrendScore('camel', selections);
    expect(trend.isTrending).toBe(true);
    expect(trend.trendScore).toBeGreaterThan(100);
    expect(trend.savesCount).toBe(135);

    // Non-trending combo should return 0
    const nonTrend = calculateTrendScore('red', selections);
    expect(nonTrend.isTrending).toBe(false);
    expect(nonTrend.trendScore).toBe(0);
  });

  test('Harmonious pattern mixing', () => {
    // Subtle plaid + solid base (stripe + denim) is harmonious
    const harmonious = areHarmoniousPatterns('stripe', 'denim');
    expect(harmonious.isHarmonious).toBe(true);
    expect(harmonious.saves).toBeGreaterThan(50);

    // Clashing patterns (camo + plaid) is not harmonious
    const clashing = areHarmoniousPatterns('camo', 'plaid');
    expect(clashing.isHarmonious).toBe(false);
  });

  test('Detailed score explanations & filter promotion boosts in freeform scoring', () => {
    const selections = {
      topColor: 'black',
      bottomColor: 'charcoal'
    };
    
    // Normal scoring with occasion filter 'formal'
    const resultWithFilter = scoreGarmentForAnySequence('outerwearColor', 'navy', selections, 10, { occasion: 'formal' });
    expect(resultWithFilter.score).toBeGreaterThan(0);
    expect(resultWithFilter.explanation).toContain('filter boost (+15)');
    expect(resultWithFilter.reasons.some(r => r.includes('Promoted for selected occasion'))).toBe(true);

    // Normal scoring without filter
    const resultWithoutFilter = scoreGarmentForAnySequence('outerwearColor', 'navy', selections, 10);
    expect(resultWithoutFilter.explanation).not.toContain('filter boost (+15)');
  });

  test('Alias resolution logic in matching engines', () => {
    // 1. Check resolveColor function works directly
    expect(engine.resolveColor('blackcats')).toBe('black');
    expect(anySequenceEngine.resolveColor('blackcats')).toBe('black');
    
    // camel should NOT resolve to khaki because it exists in active colors!
    expect(engine.resolveColor('camel')).toBe('camel');

    // 2. Sequential Filter Options
    const optionsForBlack = engine.getBottomOptions('black');
    const optionsForBlackCats = engine.getBottomOptions('blackcats');
    expect(optionsForBlack.length).toBeGreaterThan(0);
    expect(optionsForBlackCats).toEqual(optionsForBlack);

    // 3. Any Sequence Filter Options
    const optionsAnyBlack = anySequenceEngine.getOptionsForAnySequence({ topColor: 'black' });
    const optionsAnyBlackCats = anySequenceEngine.getOptionsForAnySequence({ topColor: 'blackcats' });
    expect(optionsAnyBlack.bottomColor.length).toBeGreaterThan(0);
    expect(optionsAnyBlackCats.bottomColor).toEqual(optionsAnyBlack.bottomColor);
  });
});
