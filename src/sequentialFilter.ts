/**
 * ============================================================================
 * SEQUENTIAL OUTFIT COLOR FILTER ENGINE
 * ============================================================================
 *
 * Purpose : At each outfit-building step, return ranked color options that
 *           will produce a harmonious complete outfit.
 * Data    : Reads colorcombos.csv (25k rows) + colorshex.csv into memory.
 * Scoring : Multi-factor 0-100 scoring (frequency, harmony, contrast, tone,
 *           neutral bonus).
 *
 * Flow    : TOP → BOTTOM → OUTERWEAR → FOOTWEAR → predict TOP_OUTER
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { flagger } from './flaggingSystem';
import { colorAliasResolver } from './aliasResolver';

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ColorInfo {
  name: string;
  hex: string;
  isAlias: boolean;
}

export interface ColorOption {
  color: string;
  hex: string;
  score: number;
  frequency: number;
  reasons: string[];
  isFlagged?: boolean;
  flagReason?: string;
  patternUrl?: string;
  occasions?: string[];
  vibe?: string;
  fitType?: string;
  explanation?: string;
}

export interface PredictionResult {
  primary: ColorOption;
  alternatives: ColorOption[];
  totalCombosSearched: number;
  matchType: 'exact' | 'partial' | 'scored' | 'fallback';
}

export interface ComboRow {
  topColor: string;
  topOuterColor: string;
  bottomColor: string;
  outerwearColor: string;
  footwearColor: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. COLOR FAMILY SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

export enum ColorFamily {
  NEUTRAL  = 'neutral',   // black, white, grey, charcoal, tan, camel, sand, beige
  WARM     = 'warm',      // red, orange, yellow, burgundy, burnt-orange, mustard
  COOL     = 'cool',      // blue, navy, teal, purple, indigo, mint
  EARTH    = 'earth',     // olive, forestgreen, green, khaki, tobacco, brown
  PASTEL   = 'pastel',    // lightpink, dustypink, lightblue, lavender
  PATTERN  = 'pattern',   // camo, tartan, houndstooth, plaid, gingham
}

// Maps every known color name/substring → ColorFamily
const COLOR_FAMILY_MAP: Record<string, ColorFamily> = {
  // ── NEUTRALS ──
  black: ColorFamily.NEUTRAL, charcoal: ColorFamily.NEUTRAL,
  white: ColorFamily.NEUTRAL, offwhite: ColorFamily.NEUTRAL,
  grey: ColorFamily.NEUTRAL, lightgrey: ColorFamily.NEUTRAL,
  slate: ColorFamily.NEUTRAL, sand: ColorFamily.NEUTRAL,
  tan: ColorFamily.NEUTRAL, camel: ColorFamily.NEUTRAL,
  brown: ColorFamily.NEUTRAL, tobacco: ColorFamily.NEUTRAL,
  vegtan: ColorFamily.NEUTRAL, shadows: ColorFamily.NEUTRAL,
  sail: ColorFamily.NEUTRAL, photondust: ColorFamily.NEUTRAL,
  taupe: ColorFamily.NEUTRAL, warmgrey: ColorFamily.NEUTRAL,
  // ── WARM ──
  red: ColorFamily.WARM, burgundy: ColorFamily.WARM,
  oxblood: ColorFamily.WARM, maroon: ColorFamily.WARM,
  burntorange: ColorFamily.WARM, orange: ColorFamily.WARM,
  yellow: ColorFamily.WARM, mustard: ColorFamily.WARM,
  rust: ColorFamily.WARM, gold: ColorFamily.WARM,
  bred: ColorFamily.WARM, breds: ColorFamily.WARM,
  laserorange: ColorFamily.WARM, coral: ColorFamily.WARM,
  // ── COOL ──
  blue: ColorFamily.COOL, navy: ColorFamily.COOL,
  royalblue: ColorFamily.COOL, lightblue: ColorFamily.COOL,
  teal: ColorFamily.COOL, turquoise: ColorFamily.COOL,
  purple: ColorFamily.COOL, deeppurple: ColorFamily.COOL,
  lavender: ColorFamily.COOL, indigo: ColorFamily.COOL,
  mint: ColorFamily.COOL, violet: ColorFamily.COOL,
  mediumcurry: ColorFamily.COOL, midnightblue: ColorFamily.COOL,
  frenchblue: ColorFamily.COOL,
  // ── EARTH ──
  olivegreen: ColorFamily.EARTH, green: ColorFamily.EARTH,
  forestgreen: ColorFamily.EARTH, khaki: ColorFamily.EARTH,
  olive: ColorFamily.EARTH, sage: ColorFamily.EARTH,
  // ── PASTELS ──
  lightpink: ColorFamily.PASTEL, dustypink: ColorFamily.PASTEL,
  hotpink: ColorFamily.PASTEL, pink: ColorFamily.PASTEL,
  coast: ColorFamily.PASTEL,
  // ── PATTERNS (wildcard) ──
  camo: ColorFamily.PATTERN, tartan: ColorFamily.PATTERN,
  houndstooth: ColorFamily.PATTERN, plaid: ColorFamily.PATTERN,
  gingham: ColorFamily.PATTERN,
};

// Which families pair well together
const HARMONY_TABLE: Record<ColorFamily, ColorFamily[]> = {
  [ColorFamily.NEUTRAL]:  [ColorFamily.NEUTRAL, ColorFamily.WARM, ColorFamily.COOL, ColorFamily.EARTH, ColorFamily.PASTEL, ColorFamily.PATTERN],
  [ColorFamily.WARM]:     [ColorFamily.NEUTRAL, ColorFamily.COOL, ColorFamily.EARTH],
  [ColorFamily.COOL]:     [ColorFamily.NEUTRAL, ColorFamily.WARM, ColorFamily.EARTH, ColorFamily.PASTEL],
  [ColorFamily.EARTH]:    [ColorFamily.NEUTRAL, ColorFamily.COOL, ColorFamily.PASTEL, ColorFamily.WARM],
  [ColorFamily.PASTEL]:   [ColorFamily.NEUTRAL, ColorFamily.COOL, ColorFamily.EARTH],
  [ColorFamily.PATTERN]:  [ColorFamily.NEUTRAL, ColorFamily.COOL, ColorFamily.EARTH],
};

// Families that clash and should be penalised
const CLASH_TABLE: Record<ColorFamily, ColorFamily[]> = {
  [ColorFamily.NEUTRAL]: [],
  [ColorFamily.WARM]:    [ColorFamily.PASTEL],
  [ColorFamily.COOL]:    [],
  [ColorFamily.EARTH]:   [],
  [ColorFamily.PASTEL]:  [ColorFamily.WARM],
  [ColorFamily.PATTERN]: [ColorFamily.PATTERN],
};

export function getFamily(color: string): ColorFamily {
  const c = color.toLowerCase().replace(/[-_\s]/g, '');

  // Direct lookup first
  if (COLOR_FAMILY_MAP[c]) return COLOR_FAMILY_MAP[c];

  // Substring scan (handles composite names like "greycamo", "khakicamo", etc.)
  for (const [key, family] of Object.entries(COLOR_FAMILY_MAP)) {
    if (c.includes(key) || key.includes(c)) return family;
  }

  // Infer from substrings
  if (
    c.includes('camo') ||
    c.includes('tartan') ||
    c.includes('houndstooth') ||
    c.includes('plaid') ||
    c.includes('gingham') ||
    c.includes('stripe') ||
    c.includes('chalkstripe') ||
    c.includes('polkadot') ||
    c.includes('dots') ||
    c.includes('leopard') ||
    c.includes('herringbone') ||
    c.includes('denim') ||
    c.includes('marled')
  ) {
    return ColorFamily.PATTERN;
  }
  if (c.includes('grey') || c.includes('gray') || c.includes('silver'))       return ColorFamily.NEUTRAL;
  if (c.includes('blue') || c.includes('navy'))                                return ColorFamily.COOL;
  if (c.includes('green') || c.includes('olive'))                              return ColorFamily.EARTH;
  if (c.includes('pink') || c.includes('rose'))                                return ColorFamily.PASTEL;
  if (c.includes('red') || c.includes('burg') || c.includes('orange'))        return ColorFamily.WARM;

  return ColorFamily.NEUTRAL; // safe default
}

export function isHarmonious(a: ColorFamily, b: ColorFamily): boolean {
  return HARMONY_TABLE[a]?.includes(b) ?? false;
}

export function isClash(a: ColorFamily, b: ColorFamily): boolean {
  return CLASH_TABLE[a]?.includes(b) ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// METADATA TAGGING HELPER
// ─────────────────────────────────────────────────────────────────────────────

export function getMetadataTags(color: string): { occasions: string[]; vibe: string; fitType: string } {
  const c = color.toLowerCase().replace(/[-_\s]/g, '');
  
  // ── OCCASIONS ──
  let occasions: string[] = ['casual'];
  if (
    c.includes('chalkstripe') ||
    c.includes('herringbone') ||
    c === 'black' ||
    c === 'charcoal' ||
    c === 'navy' ||
    c === 'darknavy' ||
    c === 'white' ||
    c === 'offwhite' ||
    c === 'grey' ||
    c === 'gray' ||
    c === 'slate' ||
    c === 'taupe' ||
    c === 'warmgrey'
  ) {
    occasions = ['formal', 'casual'];
  } else if (
    c.includes('marled') ||
    c.includes('dots') ||
    c.includes('polkadot') ||
    c.includes('athletic')
  ) {
    occasions = ['athletic', 'casual'];
  }

  // ── VIBES ──
  let vibe = 'minimalist';
  const family = getFamily(color);
  if (
    family === ColorFamily.PATTERN ||
    family === ColorFamily.WARM ||
    c.includes('leopard') ||
    c.includes('camo') ||
    c.includes('tartan') ||
    c.includes('plaid') ||
    c.includes('gingham') ||
    c.includes('stripe') ||
    c.includes('dots') ||
    c.includes('polkadot')
  ) {
    vibe = 'maximalist';
  }

  // ── FIT TYPE ──
  let fitType = 'fitted';
  if (
    c.includes('camo') ||
    c.includes('denim') ||
    c.includes('tartan') ||
    c.includes('plaid') ||
    c.includes('marled') ||
    c.includes('oversized')
  ) {
    fitType = 'oversized';
  }

  return { occasions, vibe, fitType };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEASONALITY AND TREND BOOST HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function getSeasonalBoost(color: string): { boost: number; season: string; reason?: string } {
  const month = new Date().getMonth();
  const dark = isDarkColor(color);
  const family = getFamily(color);

  // Winter: Dec (11), Jan (0), Feb (1)
  if (month === 11 || month === 0 || month === 1) {
    if (dark || family === ColorFamily.WARM) {
      return {
        boost: 5,
        season: 'Winter',
        reason: 'Winter Boost: Dark/warm tones hold greater visual warmth (+5)'
      };
    }
  }
  // Summer: Jun (5), Jul (6), Aug (7)
  else if (month === 5 || month === 6 || month === 7) {
    if (!dark || family === ColorFamily.COOL) {
      return {
        boost: 5,
        season: 'Summer',
        reason: 'Summer Boost: Light/cool tones reflect summer brightness (+5)'
      };
    }
  }

  return { boost: 0, season: 'Spring/Fall' };
}

const TRENDING_COMBOS = [
  ['black', 'camel', 'charcoal'],
  ['navy', 'offwhite', 'sand'],
  ['olivegreen', 'black', 'grey'],
];

export function calculateTrendScore(candidate: string, selections: ScoringContext): { isTrending: boolean; savesCount: number; trendScore: number } {
  const activeColors = Object.values(selections).filter(Boolean).map(c => c!.toLowerCase().replace(/[-_\s]/g, ''));
  const candLower = candidate.toLowerCase().replace(/[-_\s]/g, '');

  if (activeColors.length === 0) return { isTrending: false, savesCount: 0, trendScore: 0 };

  let matchedCombo = false;
  for (const combo of TRENDING_COMBOS) {
    const cleanCombo = combo.map(c => c.replace(/[-_\s]/g, ''));
    if (cleanCombo.includes(candLower)) {
      const otherComboColors = cleanCombo.filter(c => c !== candLower);
      const matchesActive = otherComboColors.some(c => activeColors.includes(c));
      if (matchesActive) {
        matchedCombo = true;
        break;
      }
    }
  }

  if (!matchedCombo) return { isTrending: false, savesCount: 0, trendScore: 0 };

  const baseSaves = 135;
  const daysElapsed = 2.5; 
  const trendScore = Math.round(baseSaves * Math.exp(-0.05 * daysElapsed)); 
  
  return {
    isTrending: trendScore > 100,
    savesCount: baseSaves,
    trendScore
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN HARMONY LOOKUPS
// ─────────────────────────────────────────────────────────────────────────────

const HARMONY_HARMONIOUS_PAIRS_SAVES: Record<string, number> = {
  'stripe_denim': 85,
  'chalkstripe_denim': 64,
  'herringbone_denim': 112,
  'marled_denim': 95,
  'plaid_denim': 120,
  'houndstooth_denim': 55,
  'stripe_marled': 72,
  'chalkstripe_marled': 58,
};

export function areHarmoniousPatterns(colorA: string, colorB: string): { isHarmonious: boolean; saves: number } {
  const cleanA = colorA.toLowerCase().replace(/[-_\s]/g, '');
  const cleanB = colorB.toLowerCase().replace(/[-_\s]/g, '');

  const keywords = ['stripe', 'chalkstripe', 'herringbone', 'marled', 'plaid', 'houndstooth', 'denim', 'dots', 'polkadot', 'leopard', 'camo', 'gingham', 'tartan'];
  const kwA = keywords.find(kw => cleanA.includes(kw));
  const kwB = keywords.find(kw => cleanB.includes(kw));

  if (!kwA || !kwB) return { isHarmonious: false, saves: 0 };

  const key1 = `${kwA}_${kwB}`;
  const key2 = `${kwB}_${kwA}`;

  if (HARMONY_HARMONIOUS_PAIRS_SAVES[key1]) return { isHarmonious: true, saves: HARMONY_HARMONIOUS_PAIRS_SAVES[key1] };
  if (HARMONY_HARMONIOUS_PAIRS_SAVES[key2]) return { isHarmonious: true, saves: HARMONY_HARMONIOUS_PAIRS_SAVES[key2] };

  return { isHarmonious: false, saves: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. COLOR HEX LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

class ColorHexIndex {
  private map = new Map<string, string>(); // name → hex

  loadFromCsv(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 3) continue;
      const name = parts[1]?.trim().toLowerCase();
      const hex  = parts[2]?.trim();
      if (name && hex) this.map.set(name, hex);
    }
  }

  getHex(colorName: string): string {
    const key = colorName.toLowerCase().replace(/[-_\s]/g, '');
    if (this.map.has(key)) return this.map.get(key)!;

    // Substring fallback
    for (const [name, hex] of this.map) {
      if (key.includes(name) || name.includes(key)) return hex;
    }

    // Auto-generate a colour for unknown names so the UI always gets something
    return this.syntheticHex(colorName);
  }

  private syntheticHex(name: string): string {
    const fam = getFamily(name);
    const defaults: Record<ColorFamily, string> = {
      [ColorFamily.NEUTRAL]: '#888888',
      [ColorFamily.WARM]:    '#cc5500',
      [ColorFamily.COOL]:    '#4b91d2',
      [ColorFamily.EARTH]:   '#4a5e2a',
      [ColorFamily.PASTEL]:  '#e6bacc',
      [ColorFamily.PATTERN]: '#aaaaaa',
    };
    return defaults[fam];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. COMBO INDEX (in-memory)
// ─────────────────────────────────────────────────────────────────────────────

class ComboIndex {
  private rows: ComboRow[] = [];

  /** Async stream-based CSV parser — handles 25k rows without blocking. */
  async loadFromCsv(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
      });

      let header = true;
      rl.on('line', (line) => {
        if (header) { header = false; return; }
        if (!line.trim()) return;

        // Parse CSV (id,top_color,top_outer_color,bottom_color,outerwear_color,footwear_color,...)
        const parts = line.split(',');
        if (parts.length < 6) return;

        this.rows.push({
          topColor:      parts[1]?.trim() || '',
          topOuterColor: parts[2]?.trim() || '-',
          bottomColor:   parts[3]?.trim() || '',
          outerwearColor: parts[4]?.trim() || '',
          footwearColor: parts[5]?.trim() || '',
        });
      });

      rl.on('close', () => resolve());
      rl.on('error', reject);
    });
  }

  getRows(): ComboRow[] { return this.rows; }
  size(): number { return this.rows.length; }

  /**
   * Find all rows that match the given (partial) outfit and have
   * a real top_outer_color (not '-').
   */
  findMatchingRows(
    topColor?: string,
    bottomColor?: string,
    outerwearColor?: string,
    footwearColor?: string,
  ): ComboRow[] {
    return this.rows.filter(r => {
      if (topColor      && r.topColor      !== topColor)      return false;
      if (bottomColor   && r.bottomColor   !== bottomColor)   return false;
      if (outerwearColor && r.outerwearColor !== outerwearColor) return false;
      if (footwearColor && r.footwearColor !== footwearColor) return false;
      return r.topOuterColor !== '-' && r.topOuterColor !== '';
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 5. SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoringContext {
  topColor?: string;
  bottomColor?: string;
  outerwearColor?: string;
  footwearColor?: string;
  topOuterColor?: string;
}

/**
 * Classifies if a color name represents a dark, deep color tone
 * vs a light, bright color tone.
 */
export function isDarkColor(color: string): boolean {
  const c = color.toLowerCase().replace(/[-_\s]/g, '');
  if (
    c.includes('light') ||
    c.includes('white') ||
    c === 'sand' ||
    c === 'sail' ||
    c === 'photondust' ||
    c === 'mint' ||
    c === 'lavender' ||
    c === 'sage' ||
    c === 'beige'
  ) {
    return false;
  }
  if (
    c.includes('black') ||
    c.includes('dark') ||
    c.includes('charcoal') ||
    c.includes('navy') ||
    c.includes('indigo') ||
    c.includes('burgundy') ||
    c.includes('maroon') ||
    c.includes('oxblood') ||
    c.includes('tobacco') ||
    c.includes('brown') ||
    c.includes('forest') ||
    c.includes('olive') ||
    c.includes('midnight') ||
    c === 'frenchblue'
  ) {
    return true;
  }

  const family = getFamily(color);
  if (family === ColorFamily.NEUTRAL && (c.includes('grey') || c.includes('gray'))) {
    return !c.includes('light');
  }
  if (family === ColorFamily.PASTEL) return false;
  return true;
}

function scoreTopOuter(
  candidate: string,
  ctx: ScoringContext,
  frequency: number,
  filters?: { occasion?: string; vibe?: string; fitType?: string }
): { score: number; reasons: string[]; explanation: string } {
  let score = 0;
  const reasons: string[] = [];
  const candFam = getFamily(candidate);
  const candDark = isDarkColor(candidate);

  // ── Factor 1: DB Frequency (0–25 pts) ──────────────────────────────────────
  const freqScore = Math.min(frequency * 2.5, 25);
  score += freqScore;
  if (frequency > 5) {
    reasons.push('Popular choice in fashion combinations');
  } else if (frequency > 1) {
    reasons.push('Coordinates well with your chosen base colors');
  }

  // ── Factor 2: Aesthetic Harmony / Styling Heuristics (0–45 pts) ────────────
  let harmonyScore = 0;
  if (ctx.outerwearColor) {
    const owFam = getFamily(ctx.outerwearColor);
    if (candFam === owFam) {
      harmonyScore += 20;
      reasons.push(`Cohesively matches the color family of your outerwear (${ctx.outerwearColor})`);
    } else if (isHarmonious(candFam, owFam)) {
      harmonyScore += 15;
      reasons.push(`Complements your ${ctx.outerwearColor} outerwear beautifully`);
    }
  }

  if (ctx.topColor) {
    const topFam = getFamily(ctx.topColor);
    if (candidate.toLowerCase() === ctx.topColor.toLowerCase()) {
      harmonyScore += 15;
      reasons.push('Creates a clean, unified underlayer with your top color');
    } else if (isHarmonious(candFam, topFam)) {
      harmonyScore += 10;
      reasons.push(`Provides a harmonious contrast against your ${ctx.topColor} top`);
    }
  }

  if (candFam === ColorFamily.NEUTRAL) {
    harmonyScore += 10;
    reasons.push('Neutral tone provides a versatile base that pairs with any look');
  }

  score += Math.min(harmonyScore, 45);

  // ── Factor 3: Tonal Contrast / Light-Dark Balance (0–15 pts) ───────────────
  let tonalScore = 0;

  if (ctx.topColor) {
    const topDark = isDarkColor(ctx.topColor);
    if (candDark !== topDark) {
      tonalScore += 5;
    }
  }

  if (ctx.outerwearColor) {
    const owDark = isDarkColor(ctx.outerwearColor);
    if (candDark !== owDark) {
      tonalScore += 5;
    }
    
    if (candFam === ColorFamily.NEUTRAL && candDark !== owDark) {
      tonalScore += 5;
      reasons.push('Leverages a classic high-contrast pairing (light underlayer with a dark jacket) to give the layers distinct visual appeal');
    }
  }

  score += Math.min(tonalScore, 15);

  // ── Factor 4: Visual Anchoring (Sandwich Styling Rule) (0–15 pts) ──────────
  let sandwichScore = 0;
  if (ctx.footwearColor) {
    const fwFam = getFamily(ctx.footwearColor);
    if (candidate.toLowerCase() === ctx.footwearColor.toLowerCase()) {
      sandwichScore += 15;
      reasons.push(`Anchors the outfit by repeating the top layer's color in your ${ctx.footwearColor} footwear, drawing the visual weight together`);
    } else if (candFam === fwFam) {
      sandwichScore += 10;
      reasons.push(`Color-coordinates with your footwear family (${fwFam}) to ground the overall outfit`);
    }
  }

  if (ctx.bottomColor && !ctx.footwearColor) {
    const botFam = getFamily(ctx.bottomColor);
    if (candFam === botFam) {
      sandwichScore += 5;
    }
  }

  score += Math.min(sandwichScore, 15);

  // ── Rule 5: Monochromatic Styling Rule (+15 pts) ───────────────────────────
  let monochromeScore = 0;
  if (ctx.topColor && ctx.bottomColor) {
    const topFam = getFamily(ctx.topColor);
    const botFam = getFamily(ctx.bottomColor);
    if (
      candFam === topFam &&
      candFam === botFam &&
      (candFam === ColorFamily.NEUTRAL || candFam === ColorFamily.EARTH)
    ) {
      monochromeScore = 15;
      score += monochromeScore;
      reasons.push('Creates a sophisticated, low-contrast monochromatic look, which is timeless, sleek, and highly versatile');
    }
  }

  // ── Rule 6: Seasonality Context Boosts (+5 pts) ─────────────────────────────
  const seasonBoost = getSeasonalBoost(candidate);
  score += seasonBoost.boost;
  if (seasonBoost.boost > 0 && seasonBoost.reason) {
    reasons.push(seasonBoost.reason);
  }

  // ── Rule 7: Trending Combos Boost (+10 pts) ───────────────────────────────
  const trendData = calculateTrendScore(candidate, ctx);
  if (trendData.isTrending) {
    score += 10;
    reasons.push(`🔥 Trending Combination: Saved over ${trendData.savesCount} times recently with an active decay score of ${trendData.trendScore}`);
  }

  // ── Rule 8: Context Filter Promotion Boost (+15 pts) ───────────────────────
  let filterPromoBoost = 0;
  const meta = getMetadataTags(candidate);
  if (filters) {
    if (filters.occasion && filters.occasion !== 'any') {
      if (meta.occasions.includes(filters.occasion.toLowerCase())) {
        filterPromoBoost = 15;
        reasons.push(`Promoted for selected occasion (${filters.occasion}) (+15)`);
      }
    }
    if (filters.vibe && filters.vibe !== 'any') {
      if (meta.vibe === filters.vibe.toLowerCase()) {
        filterPromoBoost = 15;
        reasons.push(`Promoted for selected vibe (${filters.vibe}) (+15)`);
      }
    }
    if (filters.fitType && filters.fitType !== 'any') {
      if (meta.fitType === filters.fitType.toLowerCase()) {
        filterPromoBoost = 15;
        reasons.push(`Promoted for selected fit type (${filters.fitType}) (+15)`);
      }
    }
  }
  score += filterPromoBoost;

  // ── Rule 9: Pattern Isolation & Clashing Penalties (-25 pts max) ───────────
  let clashPenalty = 0;

  if (ctx.outerwearColor) {
    const owFam = getFamily(ctx.outerwearColor);
    if (isClash(candFam, owFam)) {
      clashPenalty += 15;
      reasons.push(`Clashes aggressively with the color tones of your ${ctx.outerwearColor} outerwear`);
    }
  }

  if (ctx.bottomColor) {
    const botFam = getFamily(ctx.bottomColor);
    if (isClash(candFam, botFam)) {
      clashPenalty += 10;
      reasons.push(`Tonal conflict with your chosen bottoms (${ctx.bottomColor})`);
    }
  }

  const activePatternGarments = [ctx.topColor, ctx.bottomColor, ctx.outerwearColor]
    .filter(Boolean) as string[];
  const hasPatternInOutfit = activePatternGarments.some(c => getFamily(c) === ColorFamily.PATTERN);

  if (hasPatternInOutfit) {
    if (candFam === ColorFamily.PATTERN) {
      // Check if there are harmonious patterns
      let patternAllowed = false;
      let patternSaves = 0;
      for (const p of activePatternGarments) {
        if (getFamily(p) === ColorFamily.PATTERN) {
          const check = areHarmoniousPatterns(candidate, p);
          if (check.isHarmonious) {
            patternAllowed = true;
            patternSaves = check.saves;
            break;
          }
        }
      }

      if (patternAllowed) {
        reasons.push(`✨ Harmonious Pattern Mixing: Proven pairing in our style logs with over ${patternSaves} saves`);
      } else {
        clashPenalty += 25;
        reasons.push('Avoid stacking multiple patterns in a single outfit to prevent visual clutter');
      }
    } else if (candFam === ColorFamily.NEUTRAL) {
      score += 10;
      reasons.push('Grounds the active patterns in your outfit with a solid, clean neutral layer');
    }
  }

  score -= Math.min(clashPenalty, 25);

  const finalScore = Math.max(0, Math.min(100, score));

  // Determine overall styling verdict
  if (finalScore >= 75) {
    reasons.unshift(`✨ Premium Cohesion (${finalScore}/100): Excellent pairing! The selected candidate perfectly aligns with color harmony rules, anchoring your outfit's visual weight and maintaining a balanced tonal contrast to create a highly polished look.`);
  } else if (finalScore >= 50) {
    reasons.unshift(`✅ Decent Match (${finalScore}/100): A safe, everyday choice. While it coordinates cleanly without clashing, it lacks distinct styling anchors (like the Sandwich rule or high-contrast layering) that would make it a standout look.`);
  } else {
    reasons.unshift(`⚠️ Stylist Warning (${finalScore}/100): This combination creates visual friction. The tones compete with one another, resulting in either a flat, uninspired pairing or a chaotic distribution that lacks visual balance.`);
  }

  // Provide custom detailed critiques for lower scores
  if (finalScore < 50) {
    if (clashPenalty > 0) {
      reasons.push(`❌ Risky Clash: The color families clash directly. Mixing aggressive brights/neons with soft pastels creates jarring visual competition that disrupts outfit cohesion.`);
    }
    if (hasPatternInOutfit && candFam === ColorFamily.PATTERN) {
      reasons.push(`❌ Pattern Overload: Stacking multiple patterns (like plaid with camo) is a styling mistake. It creates busy visual noise. Try replacing one patterned layer with a solid neutral.`);
    }
    // Check for flat contrast
    let hasTonalBreak = false;
    if (ctx.topColor && candDark !== isDarkColor(ctx.topColor)) hasTonalBreak = true;
    if (ctx.outerwearColor && candDark !== isDarkColor(ctx.outerwearColor)) hasTonalBreak = true;
    if (!hasTonalBreak && (ctx.topColor || ctx.outerwearColor)) {
      reasons.push(`❌ Flat Layering: Lacks a tonal break. Because the garment shares the exact same light/dark value as adjacent layers, the outfit lacks visual depth, making the layering look flat.`);
    }
    // Check for visual weight
    if (ctx.footwearColor && candidate.toLowerCase() !== ctx.footwearColor.toLowerCase() && candFam !== getFamily(ctx.footwearColor)) {
      reasons.push(`❌ Unanchored Styling: Lacks anchoring. Without repeating any color from your upper body in your footwear (the classic Sandwich Rule), the outfit's visual weight is left top-heavy and disconnected.`);
    }
  }

  // Generate Score Explanation breakdown
  const explanationParts: string[] = [];
  if (frequency > 0) {
    explanationParts.push(`Classic pairing (freq: ${frequency}×)`);
  } else {
    explanationParts.push(`Style suggestion`);
  }
  if (harmonyScore > 0) explanationParts.push(`complements style (+${Math.round(harmonyScore)})`);
  if (tonalScore > 0) explanationParts.push(`contrast break (+${Math.round(tonalScore)})`);
  if (sandwichScore > 0) explanationParts.push(`anchored look (+${Math.round(sandwichScore)})`);
  if (monochromeScore > 0) explanationParts.push(`monochromatic bonus (+15)`);
  if (filterPromoBoost > 0) explanationParts.push(`filter boost (+15)`);
  if (seasonBoost.boost > 0) explanationParts.push(`seasonality (+5)`);
  if (trendData.isTrending) explanationParts.push(`trending saves (+10)`);
  if (clashPenalty > 0) explanationParts.push(`clashing penalty (-${Math.round(clashPenalty)})`);

  const explanation = explanationParts.join(' + ');

  return { score: finalScore, reasons, explanation };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SEQUENTIAL FILTER ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export class SequentialFilterEngine {
  private index  = new ComboIndex();
  private hexIdx = new ColorHexIndex();
  private ready  = false;
  public patterns = new Set<string>();
  public activeColors = new Set<string>();

  async initialize(csvDir: string): Promise<void> {
    const combosPath  = path.join(csvDir, 'data', 'colorcombos.csv');
    const hexPath     = path.join(csvDir, 'data', 'colorshex.csv');

    // Initialize alias resolver
    colorAliasResolver.initialize(csvDir);

    await this.index.loadFromCsv(combosPath);
    this.hexIdx.loadFromCsv(hexPath);

    // Read all pattern names from public/patterns
    const patternsPath = path.join(csvDir, 'public', 'patterns');
    if (fs.existsSync(patternsPath)) {
      const files = fs.readdirSync(patternsPath);
      for (const f of files) {
        if (f.endsWith('.png')) {
          const colorName = f.substring(0, f.length - 4).toLowerCase();
          this.patterns.add(colorName);
        }
      }
      console.log(`✅ SequentialFilterEngine loaded ${this.patterns.size} pattern images from public/patterns`);
    }

    // Populate activeColors set with all colors present in combos dataset
    this.activeColors.clear();
    for (const r of this.index.getRows()) {
      if (r.topColor && r.topColor !== '-') this.activeColors.add(r.topColor.toLowerCase());
      if (r.bottomColor && r.bottomColor !== '-') this.activeColors.add(r.bottomColor.toLowerCase());
      if (r.outerwearColor && r.outerwearColor !== '-') this.activeColors.add(r.outerwearColor.toLowerCase());
      if (r.footwearColor && r.footwearColor !== '-') this.activeColors.add(r.footwearColor.toLowerCase());
      if (r.topOuterColor && r.topOuterColor !== '-') this.activeColors.add(r.topOuterColor.toLowerCase());
    }
    for (const p of this.patterns) {
      this.activeColors.add(p.toLowerCase());
    }

    this.ready = true;
    console.log(`✅ SequentialFilterEngine loaded ${this.index.size()} combos`);
  }

  resolveColor(colorName: string): string {
    return colorAliasResolver.resolve(colorName, this.activeColors);
  }

  private ensureReady() {
    if (!this.ready) throw new Error('Engine not initialized — call initialize() first');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  getAllUniqueColors(): ColorOption[] {
    this.ensureReady();
    const colors = new Set<string>();
    for (const r of this.index.getRows()) {
      if (r.topColor && r.topColor !== '-') colors.add(r.topColor);
      if (r.bottomColor && r.bottomColor !== '-') colors.add(r.bottomColor);
      if (r.outerwearColor && r.outerwearColor !== '-') colors.add(r.outerwearColor);
      if (r.footwearColor && r.footwearColor !== '-') colors.add(r.footwearColor);
      if (r.topOuterColor && r.topOuterColor !== '-') colors.add(r.topOuterColor);
    }
    // Inject all pattern colors
    for (const p of this.patterns) {
      colors.add(p);
    }

    return Array.from(colors)
      .sort()
      .map(color => {
        const meta = getMetadataTags(color);
        const option: ColorOption = {
          color,
          hex: this.hexIdx.getHex(color),
          score: 100,
          frequency: 1,
          reasons: ['Initial selection color from database'],
          occasions: meta.occasions,
          vibe: meta.vibe,
          fitType: meta.fitType,
          explanation: 'Initial selection color'
        };
        if (this.patterns.has(color.toLowerCase())) {
          option.patternUrl = `/patterns/${color.toLowerCase()}.png`;
        }
        return option;
      });
  }

  private padOptions(
    currentOptions: ColorOption[],
    ctx: ScoringContext,
    targetSlot: 'topColor' | 'bottomColor' | 'outerwearColor' | 'footwearColor' | 'topOuterColor',
    filters?: { occasion?: string; vibe?: string; fitType?: string }
  ): ColorOption[] {
    if (currentOptions.length >= 5) {
      return currentOptions;
    }

    const existingColors = new Set(currentOptions.map(o => o.color.toLowerCase()));
    const allUnique = this.getAllUniqueColors();
    const candidates: ColorOption[] = [];

    for (const item of allUnique) {
      const colorLower = item.color.toLowerCase();
      if (!existingColors.has(colorLower)) {
        // Construct hypothetical outfit to evaluate flags and scores
        const outfit = {
          topColor: ctx.topColor,
          bottomColor: targetSlot === 'bottomColor' ? item.color : ctx.bottomColor,
          outerwearColor: targetSlot === 'outerwearColor' ? item.color : ctx.outerwearColor,
          footwearColor: targetSlot === 'footwearColor' ? item.color : ctx.footwearColor,
          topOuterColor: targetSlot === 'topOuterColor' ? item.color : undefined
        };

        const flag = flagger.isFlagged(outfit);
        const { score, reasons, explanation } = scoreTopOuter(item.color, ctx, 0, filters);

        const meta = getMetadataTags(item.color);
        const option: ColorOption = {
          color: item.color,
          hex: this.hexIdx.getHex(item.color),
          score,
          frequency: 0,
          reasons: [...reasons, 'Alternative style suggestion to expand your options'],
          occasions: meta.occasions,
          vibe: meta.vibe,
          fitType: meta.fitType,
          explanation
        };

        if (this.patterns.has(colorLower)) {
          option.patternUrl = `/patterns/${colorLower}.png`;
        }

        if (flag) {
          option.score = 5;
          option.isFlagged = true;
          option.flagReason = flag.reason || 'Flagged by style team';
          option.reasons = [
            `⚠️ Style Alert: ${option.flagReason}`,
            'This combination was flagged by our styling QA testing as "will not look good on you".',
            ...reasons
          ];
        }

        candidates.push(option);
      }
    }

    // Sort: highest score first
    candidates.sort((a, b) => b.score - a.score);

    const padded = [...currentOptions];
    for (const cand of candidates) {
      if (padded.length >= 5) break;
      padded.push(cand);
    }

    return padded;
  }

  private rankColors(
    colorFreqMap: Map<string, number>,
    ctx: ScoringContext,
    filters?: { occasion?: string; vibe?: string; fitType?: string }
  ): ColorOption[] {
    const results: ColorOption[] = [];

    for (const [color, freq] of colorFreqMap) {
      // Deduce target slot
      let targetSlot: 'bottomColor' | 'outerwearColor' | 'footwearColor' | 'topOuterColor' = 'bottomColor';
      if (ctx.outerwearColor && ctx.bottomColor && ctx.topColor) {
        targetSlot = 'footwearColor';
      } else if (ctx.bottomColor && ctx.topColor) {
        targetSlot = 'outerwearColor';
      } else if (ctx.topColor) {
        targetSlot = 'bottomColor';
      }
      if (ctx.footwearColor && ctx.outerwearColor && ctx.bottomColor && ctx.topColor) {
        targetSlot = 'topOuterColor';
      }

      // Check if flagged
      const outfit = {
        topColor: ctx.topColor,
        bottomColor: targetSlot === 'bottomColor' ? color : ctx.bottomColor,
        outerwearColor: targetSlot === 'outerwearColor' ? color : ctx.outerwearColor,
        footwearColor: targetSlot === 'footwearColor' ? color : ctx.footwearColor,
        topOuterColor: targetSlot === 'topOuterColor' ? color : undefined
      };

      const flag = flagger.isFlagged(outfit);
      const { score, reasons, explanation } = scoreTopOuter(color, ctx, freq, filters);

      const meta = getMetadataTags(color);
      const option: ColorOption = {
        color,
        hex: this.hexIdx.getHex(color),
        score,
        frequency: freq,
        reasons,
        occasions: meta.occasions,
        vibe: meta.vibe,
        fitType: meta.fitType,
        explanation
      };

      const colorLower = color.toLowerCase();
      if (this.patterns.has(colorLower)) {
        option.patternUrl = `/patterns/${colorLower}.png`;
      }

      if (flag) {
        option.score = 5;
        option.isFlagged = true;
        option.flagReason = flag.reason || 'Flagged by style team';
        option.reasons = [
          `⚠️ Style Alert: ${option.flagReason}`,
          'This combination was flagged by our styling QA testing as "will not look good on you".',
          ...reasons
        ];
      }

      results.push(option);
    }

    return results.sort((a, b) => b.score - a.score || b.frequency - a.frequency);
  }

  // ── Step 1: After picking TOP — what BOTTOM colors work? ──────────────────

  getBottomOptions(topColor: string, filters?: { occasion?: string; vibe?: string; fitType?: string }): ColorOption[] {
    this.ensureReady();
    const resolvedTop = this.resolveColor(topColor);
    const rows = this.index.findMatchingRows(resolvedTop);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.bottomColor, (freq.get(r.bottomColor) || 0) + 1);

    const ranked = this.rankColors(freq, { topColor: resolvedTop }, filters);
    const padded = this.padOptions(ranked, { topColor: resolvedTop }, 'bottomColor', filters);
    return padded.slice(0, 15);
  }

  // ── Step 2: After TOP + BOTTOM — what OUTERWEAR colors work? ─────────────

  getOuterwearOptions(topColor: string, bottomColor: string, filters?: { occasion?: string; vibe?: string; fitType?: string }): ColorOption[] {
    this.ensureReady();
    const resolvedTop = this.resolveColor(topColor);
    const resolvedBottom = this.resolveColor(bottomColor);
    const rows = this.index.findMatchingRows(resolvedTop, resolvedBottom);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.outerwearColor, (freq.get(r.outerwearColor) || 0) + 1);

    // Fallback: drop bottom filter if too few results
    if (freq.size < 3) {
      const fallback = this.index.findMatchingRows(resolvedTop);
      for (const r of fallback) freq.set(r.outerwearColor, (freq.get(r.outerwearColor) || 0) + 1);
    }

    const ranked = this.rankColors(freq, { topColor: resolvedTop, bottomColor: resolvedBottom }, filters);
    const padded = this.padOptions(ranked, { topColor: resolvedTop, bottomColor: resolvedBottom }, 'outerwearColor', filters);
    return padded.slice(0, 15);
  }

  // ── Step 3: After TOP + BOTTOM + OUTERWEAR — what FOOTWEAR works? ─────────

  getFootwearOptions(topColor: string, bottomColor: string, outerwearColor: string, filters?: { occasion?: string; vibe?: string; fitType?: string }): ColorOption[] {
    this.ensureReady();
    const resolvedTop = this.resolveColor(topColor);
    const resolvedBottom = this.resolveColor(bottomColor);
    const resolvedOuter = this.resolveColor(outerwearColor);
    const rows = this.index.findMatchingRows(resolvedTop, resolvedBottom, resolvedOuter);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.footwearColor, (freq.get(r.footwearColor) || 0) + 1);

    if (freq.size < 3) {
      const fallback = this.index.findMatchingRows(resolvedTop, undefined, resolvedOuter);
      for (const r of fallback) freq.set(r.footwearColor, (freq.get(r.footwearColor) || 0) + 1);
    }

    const ranked = this.rankColors(freq, { topColor: resolvedTop, bottomColor: resolvedBottom, outerwearColor: resolvedOuter }, filters);
    const padded = this.padOptions(ranked, { topColor: resolvedTop, bottomColor: resolvedBottom, outerwearColor: resolvedOuter }, 'footwearColor', filters);
    return padded.slice(0, 15);
  }

  // ── Step 4: Predict TOP_OUTER given full outfit ───────────────────────────

  predictTopOuter(
    topColor: string,
    bottomColor: string,
    outerwearColor: string,
    footwearColor: string,
    filters?: { occasion?: string; vibe?: string; fitType?: string }
  ): PredictionResult {
    this.ensureReady();
    const resolvedTop = this.resolveColor(topColor);
    const resolvedBottom = this.resolveColor(bottomColor);
    const resolvedOuter = this.resolveColor(outerwearColor);
    const resolvedShoes = this.resolveColor(footwearColor);
    const ctx: ScoringContext = { topColor: resolvedTop, bottomColor: resolvedBottom, outerwearColor: resolvedOuter, footwearColor: resolvedShoes };

    // Exact match (all 4 garments)
    const exact = this.index.findMatchingRows(resolvedTop, resolvedBottom, resolvedOuter, resolvedShoes);
    if (exact.length > 0) {
      const freq = new Map<string, number>();
      for (const r of exact) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
      const ranked = this.rankColors(freq, ctx, filters);
      const padded = this.padOptions(ranked, ctx, 'topOuterColor', filters);
      return {
        primary: padded[0],
        alternatives: padded.slice(1, 6),
        totalCombosSearched: exact.length,
        matchType: 'exact',
      };
    }

    // Partial match (top + outerwear)
    const partial = this.index.findMatchingRows(resolvedTop, undefined, resolvedOuter);
    if (partial.length > 0) {
      const freq = new Map<string, number>();
      for (const r of partial) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
      const ranked = this.rankColors(freq, ctx, filters);
      const padded = this.padOptions(ranked, ctx, 'topOuterColor', filters);
      return {
        primary: padded[0],
        alternatives: padded.slice(1, 6),
        totalCombosSearched: partial.length,
        matchType: 'partial',
      };
    }

    // Family-based scoring across all rows with known top_outer
    const allWithOuter = this.index.findMatchingRows();
    const freq = new Map<string, number>();
    for (const r of allWithOuter) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
    const ranked = this.rankColors(freq, ctx, filters);
    const padded = this.padOptions(ranked, ctx, 'topOuterColor', filters);

    if (padded.length > 0) {
      return {
        primary: padded[0],
        alternatives: padded.slice(1, 6),
        totalCombosSearched: allWithOuter.length,
        matchType: 'scored',
      };
    }

    // Absolute fallback
    return {
      primary: { color: 'black', hex: '#000000', score: 50, frequency: 0, reasons: ['Safe neutral default'], explanation: 'Safe neutral default' },
      alternatives: [],
      totalCombosSearched: 0,
      matchType: 'fallback',
    };
  }

  // ── All distinct top_colors in the dataset ────────────────────────────────

  getAllTopColors(): ColorOption[] {
    return this.getAllUniqueColors();
  }

  // ── Expose the raw index for batch prediction ─────────────────────────────

  getAllRows(): ComboRow[] { return this.index.getRows(); }
  getHex(color: string): string { return this.hexIdx.getHex(color); }
}

// Singleton for use across the app
export const engine = new SequentialFilterEngine();
