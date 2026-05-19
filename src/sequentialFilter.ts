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
  mediumcurry: ColorFamily.COOL,
  // ── EARTH ──
  olivegreen: ColorFamily.EARTH, green: ColorFamily.EARTH,
  forestgreen: ColorFamily.EARTH, khaki: ColorFamily.EARTH,
  olive: ColorFamily.EARTH,
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

function getFamily(color: string): ColorFamily {
  const c = color.toLowerCase().replace(/[-_\s]/g, '');

  // Direct lookup first
  if (COLOR_FAMILY_MAP[c]) return COLOR_FAMILY_MAP[c];

  // Substring scan (handles composite names like "greycamo", "khakicamo", etc.)
  for (const [key, family] of Object.entries(COLOR_FAMILY_MAP)) {
    if (c.includes(key) || key.includes(c)) return family;
  }

  // Infer from substrings
  if (c.includes('camo') || c.includes('tartan') || c.includes('houndstooth') ||
      c.includes('plaid') || c.includes('gingham')) return ColorFamily.PATTERN;
  if (c.includes('grey') || c.includes('gray') || c.includes('silver'))       return ColorFamily.NEUTRAL;
  if (c.includes('blue') || c.includes('navy'))                                return ColorFamily.COOL;
  if (c.includes('green') || c.includes('olive'))                              return ColorFamily.EARTH;
  if (c.includes('pink') || c.includes('rose'))                                return ColorFamily.PASTEL;
  if (c.includes('red') || c.includes('burg') || c.includes('orange'))        return ColorFamily.WARM;

  return ColorFamily.NEUTRAL; // safe default
}

function isHarmonious(a: ColorFamily, b: ColorFamily): boolean {
  return HARMONY_TABLE[a]?.includes(b) ?? false;
}

function isClash(a: ColorFamily, b: ColorFamily): boolean {
  return CLASH_TABLE[a]?.includes(b) ?? false;
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

interface ScoringContext {
  topColor: string;
  bottomColor?: string;
  outerwearColor?: string;
  footwearColor?: string;
}

function scoreTopOuter(candidate: string, ctx: ScoringContext, frequency: number): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const candFam = getFamily(candidate);

  // ── Factor 1: DB Frequency (0–30 pts) ──────────────────────────────────────
  const freqScore = Math.min(frequency * 3, 30);
  score += freqScore;
  if (frequency > 5)  reasons.push(`Popular choice (seen ${frequency}× in data)`);
  if (frequency > 15) reasons.push('Highly popular combination');

  // ── Factor 2: Harmony with outerwear (0–25 pts) ────────────────────────────
  if (ctx.outerwearColor) {
    const owFam = getFamily(ctx.outerwearColor);
    if (candFam === owFam) {
      score += 25; reasons.push(`Matches outerwear family (${owFam})`);
    } else if (isHarmonious(candFam, owFam)) {
      score += 18; reasons.push(`Complements outerwear (${ctx.outerwearColor})`);
    } else if (isClash(candFam, owFam)) {
      score -= 15; reasons.push('Clashes with outerwear tone');
    }
  }

  // ── Factor 3: Contrast balance with top (0–20 pts) ────────────────────────
  if (ctx.topColor) {
    const topFam = getFamily(ctx.topColor);
    if (candFam === topFam) {
      score += 10; reasons.push('Matches top color family');
    } else if (isHarmonious(candFam, topFam)) {
      score += 20; reasons.push('Good contrast with top');
    }
  }

  // ── Factor 4: Tone consistency with bottom (0–15 pts) ─────────────────────
  if (ctx.bottomColor) {
    const botFam = getFamily(ctx.bottomColor);
    if (isHarmonious(candFam, botFam)) {
      score += 15; reasons.push('Works well with bottom color');
    } else if (isClash(candFam, botFam)) {
      score -= 10;
    }
  }

  // ── Factor 5: Neutral bonus (0–10 pts) ────────────────────────────────────
  if (candFam === ColorFamily.NEUTRAL) {
    score += 10; reasons.push('Neutral — works with any outfit');
  }

  // ── Factor 6: Pattern complexity penalty ──────────────────────────────────
  if (candFam === ColorFamily.PATTERN) {
    const patternsInOutfit = [ctx.topColor, ctx.bottomColor, ctx.outerwearColor]
      .filter(Boolean)
      .filter(c => getFamily(c!) === ColorFamily.PATTERN).length;
    if (patternsInOutfit >= 1) {
      score -= 20; reasons.push('Avoid mixing multiple patterns');
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SEQUENTIAL FILTER ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export class SequentialFilterEngine {
  private index  = new ComboIndex();
  private hexIdx = new ColorHexIndex();
  private ready  = false;

  async initialize(csvDir: string): Promise<void> {
    const combosPath  = path.join(csvDir, 'data', 'colorcombos.csv');
    const hexPath     = path.join(csvDir, 'data', 'colorshex.csv');

    await this.index.loadFromCsv(combosPath);
    this.hexIdx.loadFromCsv(hexPath);
    this.ready = true;
    console.log(`✅ SequentialFilterEngine loaded ${this.index.size()} combos`);
  }

  private ensureReady() {
    if (!this.ready) throw new Error('Engine not initialized — call initialize() first');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private rankColors(
    colorFreqMap: Map<string, number>,
    ctx: ScoringContext,
  ): ColorOption[] {
    const results: ColorOption[] = [];

    for (const [color, freq] of colorFreqMap) {
      const { score, reasons } = scoreTopOuter(color, ctx, freq);
      results.push({
        color,
        hex: this.hexIdx.getHex(color),
        score,
        frequency: freq,
        reasons,
      });
    }

    return results.sort((a, b) => b.score - a.score || b.frequency - a.frequency);
  }

  // ── Step 1: After picking TOP — what BOTTOM colors work? ──────────────────

  getBottomOptions(topColor: string): ColorOption[] {
    this.ensureReady();
    const rows = this.index.findMatchingRows(topColor);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.bottomColor, (freq.get(r.bottomColor) || 0) + 1);

    return this.rankColors(freq, { topColor }).slice(0, 15);
  }

  // ── Step 2: After TOP + BOTTOM — what OUTERWEAR colors work? ─────────────

  getOuterwearOptions(topColor: string, bottomColor: string): ColorOption[] {
    this.ensureReady();
    const rows = this.index.findMatchingRows(topColor, bottomColor);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.outerwearColor, (freq.get(r.outerwearColor) || 0) + 1);

    // Fallback: drop bottom filter if too few results
    if (freq.size < 3) {
      const fallback = this.index.findMatchingRows(topColor);
      for (const r of fallback) freq.set(r.outerwearColor, (freq.get(r.outerwearColor) || 0) + 1);
    }

    return this.rankColors(freq, { topColor, bottomColor }).slice(0, 15);
  }

  // ── Step 3: After TOP + BOTTOM + OUTERWEAR — what FOOTWEAR works? ─────────

  getFootwearOptions(topColor: string, bottomColor: string, outerwearColor: string): ColorOption[] {
    this.ensureReady();
    const rows = this.index.findMatchingRows(topColor, bottomColor, outerwearColor);
    const freq = new Map<string, number>();
    for (const r of rows) freq.set(r.footwearColor, (freq.get(r.footwearColor) || 0) + 1);

    if (freq.size < 3) {
      const fallback = this.index.findMatchingRows(topColor, undefined, outerwearColor);
      for (const r of fallback) freq.set(r.footwearColor, (freq.get(r.footwearColor) || 0) + 1);
    }

    return this.rankColors(freq, { topColor, bottomColor, outerwearColor }).slice(0, 15);
  }

  // ── Step 4: Predict TOP_OUTER given full outfit ───────────────────────────

  predictTopOuter(
    topColor: string,
    bottomColor: string,
    outerwearColor: string,
    footwearColor: string,
  ): PredictionResult {
    this.ensureReady();
    const ctx: ScoringContext = { topColor, bottomColor, outerwearColor, footwearColor };

    // Exact match (all 4 garments)
    const exact = this.index.findMatchingRows(topColor, bottomColor, outerwearColor, footwearColor);
    if (exact.length > 0) {
      const freq = new Map<string, number>();
      for (const r of exact) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
      const ranked = this.rankColors(freq, ctx);
      return {
        primary: ranked[0],
        alternatives: ranked.slice(1, 6),
        totalCombosSearched: exact.length,
        matchType: 'exact',
      };
    }

    // Partial match (top + outerwear)
    const partial = this.index.findMatchingRows(topColor, undefined, outerwearColor);
    if (partial.length > 0) {
      const freq = new Map<string, number>();
      for (const r of partial) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
      const ranked = this.rankColors(freq, ctx);
      return {
        primary: ranked[0],
        alternatives: ranked.slice(1, 6),
        totalCombosSearched: partial.length,
        matchType: 'partial',
      };
    }

    // Family-based scoring across all rows with known top_outer
    const allWithOuter = this.index.findMatchingRows();
    const freq = new Map<string, number>();
    for (const r of allWithOuter) freq.set(r.topOuterColor, (freq.get(r.topOuterColor) || 0) + 1);
    const ranked = this.rankColors(freq, ctx);

    if (ranked.length > 0) {
      return {
        primary: ranked[0],
        alternatives: ranked.slice(1, 6),
        totalCombosSearched: allWithOuter.length,
        matchType: 'scored',
      };
    }

    // Absolute fallback
    return {
      primary: { color: 'black', hex: '#000000', score: 50, frequency: 0, reasons: ['Safe neutral default'] },
      alternatives: [],
      totalCombosSearched: 0,
      matchType: 'fallback',
    };
  }

  // ── All distinct top_colors in the dataset ────────────────────────────────

  getAllTopColors(): ColorOption[] {
    this.ensureReady();
    const freq = new Map<string, number>();
    for (const r of this.index.getRows()) {
      freq.set(r.topColor, (freq.get(r.topColor) || 0) + 1);
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([color, frequency]) => ({
        color,
        hex: this.hexIdx.getHex(color),
        score: 100,
        frequency,
        reasons: [],
      }));
  }

  // ── Expose the raw index for batch prediction ─────────────────────────────

  getAllRows(): ComboRow[] { return this.index.getRows(); }
  getHex(color: string): string { return this.hexIdx.getHex(color); }
}

// Singleton for use across the app
export const engine = new SequentialFilterEngine();
