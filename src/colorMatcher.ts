/**
 * ============================================================================
 * COLOR MATCHING ALGORITHM - HARDCODED IMPLEMENTATION
 * ============================================================================
 * 
 * Purpose: Predict top_outer_color (jacket/hoodie) based on selected outfit colors
 * Approach: Rule-based matching with database fallback
 * Performance: <50ms response time
 * 
 * Team: Scaling Outfit Recommendation
 * Deadline: August 15, 2026
 */

import mysql from 'mysql2/promise';
import { colorAliasResolver } from './aliasResolver';
import { engine } from './sequentialFilter';

// ============================================================================
// 1. TYPES & INTERFACES
// ============================================================================

enum ColorFamily {
  NEUTRALS = 'neutrals',    // black, white, grey, brown, tan, camel, khaki
  WARM = 'warm',            // red, orange, yellow, burgundy, rust
  COOL = 'cool',            // blue, navy, teal, purple, indigo
  PASTELS = 'pastels',      // light pink, light blue, lavender, mint
  NEONS = 'neons',          // neon blue, neon green, neon pink, neon yellow
  EARTH = 'earth'           // terracotta, mustard, olive
}

interface OutfitInput {
  topColor: string;
  bottomColor: string;
  outerwearColor: string;
  footwearColor: string;
}

interface ColorScore {
  color: string;
  score: number;
  reason: string;
  frequency?: number;
}

interface TopOuterColorResult {
  primary: string;          // Best match (highest score)
  score: number;            // Score 0-100
  alternatives: ColorScore[]; // Next 4 best options
  matchType: 'exact' | 'family' | 'complementary' | 'frequency';
}

// ============================================================================
// 2. COLOR FAMILY MAPPING
// ============================================================================

const colorFamilyMap: Record<string, ColorFamily> = {
  // Neutrals
  'black': ColorFamily.NEUTRALS,
  'blackcats': ColorFamily.NEUTRALS,
  'charcoal': ColorFamily.NEUTRALS,
  'obsidianblack': ColorFamily.NEUTRALS,
  'pirateblack': ColorFamily.NEUTRALS,
  'white': ColorFamily.NEUTRALS,
  'offwhite': ColorFamily.NEUTRALS,
  'phantomwhite': ColorFamily.NEUTRALS,
  'grey': ColorFamily.NEUTRALS,
  'coolgrey': ColorFamily.NEUTRALS,
  'lightgrey': ColorFamily.NEUTRALS,
  'nickelgrey': ColorFamily.NEUTRALS,
  'warmgrey': ColorFamily.NEUTRALS,
  'slate': ColorFamily.NEUTRALS,
  'brown': ColorFamily.NEUTRALS,
  'darkbrown': ColorFamily.NEUTRALS,
  'tan': ColorFamily.NEUTRALS,
  'camel': ColorFamily.NEUTRALS,
  'oxfordtan': ColorFamily.NEUTRALS,
  'khaki': ColorFamily.NEUTRALS,
  'taupe': ColorFamily.NEUTRALS,
  'turtledove': ColorFamily.NEUTRALS,
  'vegtan': ColorFamily.NEUTRALS,
  'moonrock': ColorFamily.NEUTRALS,
  'sand': ColorFamily.NEUTRALS,
  'tobacco': ColorFamily.NEUTRALS,

  // Warm colors (reds, oranges, yellows)
  'red': ColorFamily.WARM,
  'jollyred': ColorFamily.WARM,
  'burgundy': ColorFamily.WARM,
  'oxblood': ColorFamily.WARM,
  'maroon': ColorFamily.WARM,
  'rust': ColorFamily.WARM,
  'burntorange': ColorFamily.WARM,
  'orange': ColorFamily.WARM,
  'neonorange': ColorFamily.WARM,
  'yellow': ColorFamily.WARM,
  'lightyellow': ColorFamily.WARM,
  'neonyellow': ColorFamily.WARM,
  'mustard': ColorFamily.WARM,
  'gold': ColorFamily.WARM,
  'coral': ColorFamily.WARM,

  // Cool colors (blues, teals, purples)
  'blue': ColorFamily.COOL,
  'lightblue': ColorFamily.COOL,
  'darkblue': ColorFamily.COOL,
  'frenchblue': ColorFamily.COOL,
  'midnightblue': ColorFamily.COOL,
  'navy': ColorFamily.COOL,
  'royalblue': ColorFamily.COOL,
  'neonblue': ColorFamily.COOL,
  'indigo': ColorFamily.COOL,
  'teal': ColorFamily.COOL,
  'turquoise': ColorFamily.COOL,
  'mint': ColorFamily.COOL,
  'purple': ColorFamily.COOL,
  'deeppurple': ColorFamily.COOL,
  'lavender': ColorFamily.COOL,
  'violet': ColorFamily.COOL,
  'sage': ColorFamily.COOL,

  // Pastels (soft, light colors)
  'lightpink': ColorFamily.PASTELS,
  'pink': ColorFamily.PASTELS,
  'dustypink': ColorFamily.PASTELS,
  'hotpink': ColorFamily.PASTELS,

  // Neons (bright, saturated colors)
  'neongreen': ColorFamily.NEONS,
  'neonpink': ColorFamily.NEONS,

  // Earth tones
  'olive': ColorFamily.EARTH,
  'olivegreen': ColorFamily.EARTH,
  'green': ColorFamily.EARTH,
  'forestgreen': ColorFamily.EARTH,
  'frankengreen': ColorFamily.EARTH,
};

// ============================================================================
// 3. COLOR COMPLEMENTARITY MATRIX
// ============================================================================

const complementaryPairs: Record<ColorFamily, ColorFamily[]> = {
  [ColorFamily.NEUTRALS]: [ColorFamily.WARM, ColorFamily.COOL, ColorFamily.EARTH],
  [ColorFamily.WARM]: [ColorFamily.COOL, ColorFamily.PASTELS],
  [ColorFamily.COOL]: [ColorFamily.WARM, ColorFamily.EARTH],
  [ColorFamily.EARTH]: [ColorFamily.COOL, ColorFamily.PASTELS],
  [ColorFamily.PASTELS]: [ColorFamily.WARM, ColorFamily.EARTH],
  [ColorFamily.NEONS]: [ColorFamily.NEUTRALS],
};

function isComplementary(family1: ColorFamily, family2: ColorFamily): boolean {
  return complementaryPairs[family1]?.includes(family2) ?? false;
}

function isHarmonious(family1: ColorFamily, family2: ColorFamily): boolean {
  return family1 === family2 || isComplementary(family1, family2);
}

// ============================================================================
// 4. SCORING FUNCTION
// ============================================================================

function calculateColorScore(
  topOuterColor: string,
  outfit: OutfitInput,
  outerwearFamily: ColorFamily,
  frequency: number = 0
): number {
  let score = 50; // Base score

  const topOuterFamily = colorFamilyMap[topOuterColor] || ColorFamily.NEUTRALS;
  const topFamily = colorFamilyMap[outfit.topColor] || ColorFamily.NEUTRALS;
  const bottomFamily = colorFamilyMap[outfit.bottomColor] || ColorFamily.NEUTRALS;

  // ========== PRIORITY 1: Match outerwear color (HIGHEST WEIGHT) ==========
  // The jacket is the primary visible color, so matching it is critical
  if (topOuterFamily === outerwearFamily) {
    score += 30; // Strong match: same family as jacket
  } else if (isComplementary(topOuterFamily, outerwearFamily)) {
    score += 20; // Good match: complementary to jacket (creates contrast)
  } else if (topOuterFamily === ColorFamily.NEUTRALS || outerwearFamily === ColorFamily.NEUTRALS) {
    score += 15; // Acceptable: neutrals work with anything
  } else {
    score += 0; // Poor match
  }

  // ========== PRIORITY 2: Match top color (MEDIUM-HIGH) ==========
  // The shirt underneath should also coordinate
  if (topOuterFamily === topFamily) {
    score += 10; // Matches shirt color family
  } else if (isHarmonious(topOuterFamily, topFamily)) {
    score += 5; // Harmonious with shirt
  }

  // ========== PRIORITY 3: Match bottom color (LOWER) ==========
  if (topOuterFamily === bottomFamily) {
    score += 5;
  }

  // ========== BONUS: Popularity/Frequency ==========
  // If this combo appears often in the database, it's likely a good choice
  if (frequency > 0) {
    score += Math.min(frequency * 2, 10); // Cap at 10 points
  }

  // ========== BONUS: Neutral colors are always safe ==========
  if (topOuterFamily === ColorFamily.NEUTRALS) {
    score += 8; // Neutrals almost always work
  }

  // Clamp to 0-100
  return Math.min(Math.max(score, 0), 100);
}

// ============================================================================
// 5. HELPER: COLOR RESOLUTION (ALIASING)
// ============================================================================

function resolveColor(colorName: string): string {
  if (!colorName) return '';
  const normalized = colorName.toLowerCase().trim().replace(/\s+/g, '');
  
  if (engine.activeColors && engine.activeColors.size > 0) {
    return colorAliasResolver.resolve(colorName, engine.activeColors);
  }

  // If color exists in our map, use it directly
  if (colorFamilyMap[normalized]) return normalized;

  // Manual Alias Rules (Nearest Neighbor)
  if (normalized.includes('offwhite') || normalized.includes('ivory') || normalized.includes('cream')) return 'white';
  if (normalized.includes('charcoal') || normalized.includes('darkgrey')) return 'charcoal';
  if (normalized.includes('navy') || normalized.includes('midnight')) return 'navy';
  if (normalized.includes('burgundy') || normalized.includes('maroon')) return 'burgundy';
  if (normalized.includes('olive') || normalized.includes('armygreen')) return 'olive';
  if (normalized.includes('tan') || normalized.includes('beige')) return 'tan';

  // Fallback to substring matching if possible
  for (const knownColor of Object.keys(colorFamilyMap)) {
    if (normalized.includes(knownColor) || knownColor.includes(normalized)) {
      return knownColor;
    }
  }

  return normalized;
}

// ============================================================================
// 6. MAIN ALGORITHM
// ============================================================================

async function matchTopOuterColor(
  outfit: OutfitInput,
  db: mysql.Connection
): Promise<TopOuterColorResult> {
  // Normalize and Resolve input (handling aliases/nearest neighbors)
  const normalizedOutfit: OutfitInput = {
    topColor: resolveColor(outfit.topColor),
    bottomColor: resolveColor(outfit.bottomColor),
    outerwearColor: resolveColor(outfit.outerwearColor),
    footwearColor: resolveColor(outfit.footwearColor),
  };

  // ========== STEP 1: Try exact match (fastest path) ==========
  try {
    const [exactMatches] = await db.query<any[]>(
      `SELECT DISTINCT top_outer_color FROM color_combos
       WHERE top_color = ? AND bottom_color = ? 
       AND outerwear_color = ? AND footwear_color = ?
       AND top_outer_color != '-' AND is_active = 1
       LIMIT 5`,
      [
        normalizedOutfit.topColor,
        normalizedOutfit.bottomColor,
        normalizedOutfit.outerwearColor,
        normalizedOutfit.footwearColor
      ]
    );

    if (exactMatches && exactMatches.length > 0) {
      // Return best exact match
      return buildResult(
        exactMatches[0].top_outer_color,
        100,
        'Exact match from database',
        'exact',
        exactMatches.slice(1).map(m => ({
          color: m.top_outer_color,
          score: 100,
          reason: 'Exact match from database'
        }))
      );
    }
  } catch (error) {
    console.error('Error in exact match query:', error);
  }

  // ========== STEP 2: Get outerwear-based suggestions (fallback) ==========
  const outerwearFamily = colorFamilyMap[normalizedOutfit.outerwearColor] || ColorFamily.NEUTRALS;

  let similarCombos: any[] = [];
  try {
    const [results] = await db.query<any[]>(
      `SELECT DISTINCT top_outer_color, COUNT(*) as frequency
       FROM color_combos
       WHERE outerwear_color = ? AND top_outer_color != '-'
       AND is_active = 1
       GROUP BY top_outer_color
       ORDER BY frequency DESC
       LIMIT 20`,
      [normalizedOutfit.outerwearColor]
    );
    similarCombos = results || [];
  } catch (error) {
    console.error('Error in outerwear query:', error);
    // Fallback: return hardcoded default
    return buildResult(
      'black', // Safe default
      70,
      'Database unavailable; returning safe default',
      'frequency',
      []
    );
  }

  // ========== STEP 3: Score and rank candidates ==========
  const scored: ColorScore[] = similarCombos.map(combo => ({
    color: combo.top_outer_color,
    score: calculateColorScore(
      combo.top_outer_color,
      normalizedOutfit,
      outerwearFamily,
      combo.frequency || 0
    ),
    reason: getScoreReason(
      combo.top_outer_color,
      normalizedOutfit,
      outerwearFamily
    ),
    frequency: combo.frequency
  })).sort((a, b) => b.score - a.score);

  // ========== STEP 4: Return results ==========
  if (scored.length === 0) {
    // Absolute fallback
    return buildResult('black', 50, 'No matches found; returning neutral default', 'frequency', []);
  }

  return buildResult(
    scored[0].color,
    scored[0].score,
    scored[0].reason,
    'family',
    scored.slice(1, 5)
  );
}

// ============================================================================
// 6. HELPER FUNCTIONS
// ============================================================================

function buildResult(
  primary: string,
  score: number,
  reason: string,
  matchType: 'exact' | 'family' | 'complementary' | 'frequency',
  alternatives: ColorScore[] = []
): TopOuterColorResult {
  return {
    primary,
    score,
    alternatives,
    matchType
  };
}

function getScoreReason(
  topOuterColor: string,
  outfit: OutfitInput,
  outerwearFamily: ColorFamily
): string {
  const topOuterFamily = colorFamilyMap[topOuterColor] || ColorFamily.NEUTRALS;

  if (topOuterFamily === outerwearFamily) {
    return `Matches ${outfit.outerwearColor} (same color family)`;
  } else if (isComplementary(topOuterFamily, outerwearFamily)) {
    return `Complements ${outfit.outerwearColor} (contrasts nicely)`;
  } else if (topOuterFamily === ColorFamily.NEUTRALS) {
    return `Neutral option works with any outfit`;
  } else {
    return `Compatible with ${outfit.outerwearColor}`;
  }
}

// ============================================================================
// 7. API ENDPOINT (Express.js)
// ============================================================================

// Example Express implementation
import express from 'express';

function setupColorMatchingEndpoint(
  app: express.Application,
  db: mysql.Connection
): void {
  app.post('/api/outfit/suggest-outer-color', async (req, res) => {
    try {
      const outfit: OutfitInput = req.body;

      // Validate input
      if (!outfit.topColor || !outfit.bottomColor || !outfit.outerwearColor || !outfit.footwearColor) {
        return res.status(400).json({
          error: 'Missing required fields: topColor, bottomColor, outerwearColor, footwearColor'
        });
      }

      // Get recommendation
      const result = await matchTopOuterColor(outfit, db);

      // Return response
      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error in color matching endpoint:', error);
      res.status(500).json({
        error: 'Failed to generate color recommendation',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}

// ============================================================================
// 8. TESTING
// ============================================================================

async function runTests(db: mysql.Connection): Promise<void> {
  const testCases = [
    {
      name: 'Black base outfit',
      outfit: {
        topColor: 'black',
        bottomColor: 'black',
        outerwearColor: 'black',
        footwearColor: 'white'
      }
    },
    {
      name: 'Navy blue outfit',
      outfit: {
        topColor: 'white',
        bottomColor: 'navy',
        outerwearColor: 'navy',
        footwearColor: 'black'
      }
    },
    {
      name: 'Warm earth tones',
      outfit: {
        topColor: 'rust',
        bottomColor: 'tan',
        outerwearColor: 'brown',
        footwearColor: 'sand'
      }
    }
  ];

  console.log('========== RUNNING TESTS ==========\n');

  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);
    console.log(`Input: ${JSON.stringify(testCase.outfit)}`);

    try {
      const result = await matchTopOuterColor(testCase.outfit, db);
      console.log(`Primary Suggestion: ${result.primary} (Score: ${result.score})`);
      console.log(`Match Type: ${result.matchType}`);
      console.log(`Alternatives: ${result.alternatives.map(a => a.color).join(', ')}`);
      console.log('---\n');
    } catch (error) {
      console.log(`Error: ${error}\n`);
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  matchTopOuterColor,
  setupColorMatchingEndpoint,
  runTests,
  OutfitInput,
  TopOuterColorResult,
  ColorScore,
  ColorFamily
};