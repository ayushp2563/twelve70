/**
 * ============================================================================
 * ANY-SEQUENCE OUTFIT COLOR MATCHING ENGINE
 * ============================================================================
 *
 * Purpose : Allows users to select garments in ANY arbitrary sequence.
 *           Uses Pairwise Graph Decomposition to score combinations, avoiding
 *           exponential combinatorial database explosion.
 * Data    : Parses colorcombos.csv + colorshex.csv into pairwise frequency count maps.
 * Scoring : Pairs active selections in the outfit graph, summing statistical
 *           occurrence frequency with core fashion heuristics.
 *
 * Mode    : Freeform Constraint Solver
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  ColorFamily,
  getFamily,
  isHarmonious,
  isClash,
  isDarkColor,
  ColorOption,
  ComboRow,
  getSeasonalBoost,
  calculateTrendScore,
  getMetadataTags,
  areHarmoniousPatterns
} from './sequentialFilter';
import { flagger } from './flaggingSystem';
import { colorAliasResolver } from './aliasResolver';

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface AnySequenceContext {
  topColor?: string;
  bottomColor?: string;
  outerwearColor?: string;
  footwearColor?: string;
  topOuterColor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PAIRWISE DATABASE INDEX (Graph Edges)
// ─────────────────────────────────────────────────────────────────────────────

class PairwiseIndex {
  // Key: "slotA_slotB" where slotA < slotB alphabetically
  // Value: Map of "colorA_colorB" to frequency count
  private pairs = new Map<string, Map<string, number>>();

  addPair(slotA: string, colorA: string, slotB: string, colorB: string) {
    if (colorA === '-' || colorA === '' || colorB === '-' || colorB === '') return;

    const [firstSlot, secondSlot] = slotA < slotB ? [slotA, slotB] : [slotB, slotA];
    const [firstColor, secondColor] = slotA < slotB ? [colorA, colorB] : [colorB, colorA];

    const pairKey = `${firstSlot}_${secondSlot}`;
    if (!this.pairs.has(pairKey)) {
      this.pairs.set(pairKey, new Map());
    }

    const colorMap = this.pairs.get(pairKey)!;
    const colorKey = `${firstColor.toLowerCase()}_${secondColor.toLowerCase()}`;
    colorMap.set(colorKey, (colorMap.get(colorKey) || 0) + 1);
  }

  getPairFrequency(slotA: string, colorA: string, slotB: string, colorB: string): number {
    if (colorA === '-' || colorA === '' || colorB === '-' || colorB === '') return 0;

    const [firstSlot, secondSlot] = slotA < slotB ? [slotA, slotB] : [slotB, slotA];
    const [firstColor, secondColor] = slotA < slotB ? [colorA, colorB] : [colorB, colorA];

    const pairKey = `${firstSlot}_${secondSlot}`;
    const colorMap = this.pairs.get(pairKey);
    if (!colorMap) return 0;

    const colorKey = `${firstColor.toLowerCase()}_${secondColor.toLowerCase()}`;
    return colorMap.get(colorKey) || 0;
  }
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
// 4. FREEFORM GRAPH SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export function scoreGarmentForAnySequence(
  targetSlot: string,
  candidateColor: string,
  selections: AnySequenceContext,
  pairwiseFreqScore: number,
  filters?: { occasion?: string; vibe?: string; fitType?: string }
): { score: number; reasons: string[]; explanation: string } {
  let score = 0;
  const reasons: string[] = [];
  const candFam = getFamily(candidateColor);
  const candDark = isDarkColor(candidateColor);

  const hasSelections = Object.values(selections).some(Boolean);

  // ── Factor 1: Pairwise Database Correlation (0–40 pts) ──────────────────────
  let freqScore = 0;
  if (hasSelections) {
    freqScore = Math.min(pairwiseFreqScore * 2.5, 40);
    score += freqScore;
    if (pairwiseFreqScore > 5) {
      reasons.push('Co-occurs frequently with your selected garments');
    } else if (pairwiseFreqScore > 1) {
      reasons.push('Statistically coordinates with selected items');
    }
  } else {
    // If nothing selected, uniform popular base score
    freqScore = 30;
    score += freqScore;
  }

  // ── Factor 2: Aesthetic Harmony (0–35 pts) ──────────────────────────────────
  let harmonyScore = 0;
  
  if (selections.outerwearColor && targetSlot !== 'outerwearColor') {
    const owFam = getFamily(selections.outerwearColor);
    if (candFam === owFam) {
      harmonyScore += 15;
      reasons.push(`Cohesively matches the color family of your outerwear (${selections.outerwearColor})`);
    } else if (isHarmonious(candFam, owFam)) {
      harmonyScore += 10;
      reasons.push(`Complements your ${selections.outerwearColor} outerwear beautifully`);
    } else if (isClash(candFam, owFam)) {
      score -= 20;
      reasons.push('Tonal clash with outerwear color');
    }
  }

  if (selections.topColor && targetSlot !== 'topColor') {
    const topFam = getFamily(selections.topColor);
    if (candidateColor.toLowerCase() === selections.topColor.toLowerCase()) {
      harmonyScore += 15;
      reasons.push('Creates a clean, unified base with your top color');
    } else if (isHarmonious(candFam, topFam)) {
      harmonyScore += 10;
      reasons.push(`Complements your ${selections.topColor} top`);
    }
  }

  if (selections.bottomColor && targetSlot !== 'bottomColor') {
    const botFam = getFamily(selections.bottomColor);
    if (isHarmonious(candFam, botFam)) {
      harmonyScore += 10;
    }
  }

  if (candFam === ColorFamily.NEUTRAL) {
    harmonyScore += 8;
    reasons.push('Neutral color provides a highly versatile coordination base');
  }

  score += Math.min(harmonyScore, 35);

  // ── Factor 3: Tonal Contrast (0–15 pts) ─────────────────────────────────────
  let tonalScore = 0;

  if (selections.topColor && targetSlot !== 'topColor') {
    const topDark = isDarkColor(selections.topColor);
    if (candDark !== topDark) tonalScore += 5;
  }

  if (selections.outerwearColor && targetSlot !== 'outerwearColor') {
    const owDark = isDarkColor(selections.outerwearColor);
    if (candDark !== owDark) {
      tonalScore += 5;
      if (candFam === ColorFamily.NEUTRAL) {
        tonalScore += 5;
        reasons.push('Leverages classic light-under-dark layering contrast');
      }
    }
  }

  score += Math.min(tonalScore, 15);

  // ── Factor 4: Visual Anchoring / Sandwich Styling (0–15 pts) ────────────────
  let sandwichScore = 0;
  
  if (targetSlot === 'footwearColor') {
    const anchorColor = selections.topOuterColor || selections.topColor;
    if (anchorColor) {
      const anchorFam = getFamily(anchorColor);
      if (candidateColor.toLowerCase() === anchorColor.toLowerCase()) {
        sandwichScore += 15;
        reasons.push(`Anchors the outfit by repeating the color of your ${anchorColor} upper layer`);
      } else if (candFam === anchorFam) {
        sandwichScore += 10;
        reasons.push(`Anchors the outfit by coordinating with your upper layer family (${anchorFam})`);
      }
    }
  } else if (targetSlot === 'topColor' || targetSlot === 'topOuterColor') {
    if (selections.footwearColor) {
      const fwFam = getFamily(selections.footwearColor);
      if (candidateColor.toLowerCase() === selections.footwearColor.toLowerCase()) {
        sandwichScore += 15;
        reasons.push(`Anchors the outfit by matching your ${selections.footwearColor} shoes`);
      } else if (candFam === fwFam) {
        sandwichScore += 10;
        reasons.push('Color-coordinates with your footwear family to anchor the look');
      }
    }
  }

  score += Math.min(sandwichScore, 15);

  // ── Rule 5: Monochromatic Styling Rule (+15 pts) ───────────────────────────
  let monochromeScore = 0;
  if (targetSlot === 'bottomColor' || targetSlot === 'topColor' || targetSlot === 'topOuterColor') {
    const topCol = targetSlot === 'topColor' ? candidateColor : selections.topColor;
    const botCol = targetSlot === 'bottomColor' ? candidateColor : selections.bottomColor;
    const toCol = targetSlot === 'topOuterColor' ? candidateColor : selections.topOuterColor;
    
    if (topCol && botCol) {
      const topFam = getFamily(topCol);
      const botFam = getFamily(botCol);
      const toFam = toCol ? getFamily(toCol) : topFam;
      if (
        topFam === botFam &&
        topFam === toFam &&
        (topFam === ColorFamily.NEUTRAL || topFam === ColorFamily.EARTH)
      ) {
        monochromeScore = 15;
        score += monochromeScore;
        reasons.push('Creates a sophisticated, low-contrast monochromatic flow across layers');
      }
    }
  }

  // ── Rule 6: Seasonality Context Boosts (+5 pts) ─────────────────────────────
  const seasonBoost = getSeasonalBoost(candidateColor);
  score += seasonBoost.boost;
  if (seasonBoost.boost > 0 && seasonBoost.reason) {
    reasons.push(seasonBoost.reason);
  }

  // ── Rule 7: Trending Combos Boost (+10 pts) ───────────────────────────────
  const trendData = calculateTrendScore(candidateColor, selections);
  if (trendData.isTrending) {
    score += 10;
    reasons.push(`🔥 Trending Combination: Saved over ${trendData.savesCount} times recently with an active decay score of ${trendData.trendScore}`);
  }

  // ── Rule 8: Context Filter Promotion Boost (+15 pts) ───────────────────────
  let filterPromoBoost = 0;
  const meta = getMetadataTags(candidateColor);
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

  // ── Rule 9: Pattern Isolation & Clashing ────────────────────────────────────
  let patternClash = 0;
  const activePatternGarments = [selections.topColor, selections.bottomColor, selections.outerwearColor]
    .filter(Boolean) as string[];
  const activePatterns = activePatternGarments.some(c => getFamily(c) === ColorFamily.PATTERN);

  if (activePatterns) {
    if (candFam === ColorFamily.PATTERN) {
      let patternAllowed = false;
      let patternSaves = 0;
      for (const p of activePatternGarments) {
        if (getFamily(p) === ColorFamily.PATTERN) {
          const check = areHarmoniousPatterns(candidateColor, p);
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
        patternClash += 25;
        reasons.push('Avoid pairing multiple busy patterns in a single outfit');
      }
    } else if (candFam === ColorFamily.NEUTRAL) {
      score += 10;
      reasons.push('Grounds and isolates active patterns with a solid neutral layer');
    }
  }

  score -= Math.min(patternClash, 25);

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
    if (selections.outerwearColor && targetSlot !== 'outerwearColor' && isClash(candFam, getFamily(selections.outerwearColor))) {
      reasons.push(`❌ Risky Clash: The color families clash directly with outerwear color. Mixing aggressive brights/neons with soft pastels creates jarring visual competition that disrupts outfit cohesion.`);
    }
    if (activePatterns && candFam === ColorFamily.PATTERN) {
      reasons.push(`❌ Pattern Overload: Stacking multiple patterns (like plaid with camo) is a styling mistake. Try replacing one patterned layer with a solid neutral.`);
    }
    // Check for flat contrast
    let hasTonalBreak = false;
    if (selections.topColor && targetSlot !== 'topColor' && candDark !== isDarkColor(selections.topColor)) hasTonalBreak = true;
    if (selections.outerwearColor && targetSlot !== 'outerwearColor' && candDark !== isDarkColor(selections.outerwearColor)) hasTonalBreak = true;
    if (!hasTonalBreak && (selections.topColor || selections.outerwearColor)) {
      reasons.push(`❌ Flat Layering: Lacks a tonal break. Because the garment shares the exact same light/dark value as adjacent layers, the outfit lacks visual depth, making the layering look flat.`);
    }
    // Check for visual weight
    if (targetSlot === 'footwearColor' && (selections.topOuterColor || selections.topColor)) {
      const anchorColor = selections.topOuterColor || selections.topColor;
      if (candidateColor.toLowerCase() !== anchorColor!.toLowerCase() && candFam !== getFamily(anchorColor!)) {
        reasons.push(`❌ Unanchored Styling: Lacks anchoring. Without repeating any color from your upper body in your footwear (the classic Sandwich Rule), the outfit's visual weight is left top-heavy and disconnected.`);
      }
    }
  }

  // Generate Score Explanation breakdown
  const explanationParts: string[] = [];
  if (pairwiseFreqScore > 0) {
    explanationParts.push(`Classic pairing (freq: ${pairwiseFreqScore}×)`);
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
  if (patternClash > 0) explanationParts.push(`clashing penalty (-${Math.round(patternClash)})`);

  const explanation = explanationParts.join(' + ');

  return { score: finalScore, reasons, explanation };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ANY-SEQUENCE ENGINE CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class AnySequenceFilterEngine {
  private pairwiseIndex = new PairwiseIndex();
  private hexIdx = new ColorHexIndex();
  private ready = false;
  public patterns = new Set<string>();
  public activeColors = new Set<string>();

  resolveColor(colorName: string): string {
    return colorAliasResolver.resolve(colorName, this.activeColors);
  }

  private distinctColors = {
    topColor: new Set<string>(),
    bottomColor: new Set<string>(),
    outerwearColor: new Set<string>(),
    footwearColor: new Set<string>(),
    topOuterColor: new Set<string>()
  };

  async initialize(csvDir: string): Promise<void> {
    const combosPath = path.join(csvDir, 'data', 'colorcombos.csv');
    const hexPath    = path.join(csvDir, 'data', 'colorshex.csv');

    this.hexIdx.loadFromCsv(hexPath);
    colorAliasResolver.initialize(csvDir);

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
      console.log(`✅ AnySequenceFilterEngine loaded ${this.patterns.size} pattern images from public/patterns`);
    }

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(combosPath)) {
        return reject(new Error(`colorcombos.csv not found at ${combosPath}`));
      }

      const rl = readline.createInterface({
        input: fs.createReadStream(combosPath),
        crlfDelay: Infinity,
      });

      let header = true;
      rl.on('line', (line) => {
        if (header) { header = false; return; }
        if (!line.trim()) return;

        const parts = line.split(',');
        if (parts.length < 6) return;

        const topCol      = parts[1]?.trim() || '';
        const topOuterCol = parts[2]?.trim() || '';
        const bottomCol   = parts[3]?.trim() || '';
        const outerwearCol = parts[4]?.trim() || '';
        const footwearCol = parts[5]?.trim() || '';

        // Add to distinct lists if valid
        if (topCol && topCol !== '-') this.distinctColors.topColor.add(topCol);
        if (bottomCol && bottomCol !== '-') this.distinctColors.bottomColor.add(bottomCol);
        if (outerwearCol && outerwearCol !== '-') this.distinctColors.outerwearColor.add(outerwearCol);
        if (footwearCol && footwearCol !== '-') this.distinctColors.footwearColor.add(footwearCol);
        if (topOuterCol && topOuterCol !== '-') this.distinctColors.topOuterColor.add(topOuterCol);

        // Populate pairwise indexing graph edges (10 pairs)
        const slots = [
          { name: 'topColor', val: topCol },
          { name: 'bottomColor', val: bottomCol },
          { name: 'outerwearColor', val: outerwearCol },
          { name: 'footwearColor', val: footwearCol },
          { name: 'topOuterColor', val: topOuterCol }
        ];

        for (let i = 0; i < slots.length; i++) {
          for (let j = i + 1; j < slots.length; j++) {
            this.pairwiseIndex.addPair(slots[i].name, slots[i].val, slots[j].name, slots[j].val);
          }
        }
      });

      rl.on('close', () => {
        // Inject pattern colors into distinct colors so they can be parsed by any sequence
        for (const p of this.patterns) {
          this.distinctColors.topColor.add(p);
          this.distinctColors.bottomColor.add(p);
          this.distinctColors.outerwearColor.add(p);
          this.distinctColors.footwearColor.add(p);
          this.distinctColors.topOuterColor.add(p);
        }

        this.activeColors.clear();
        for (const slot of ['topColor', 'bottomColor', 'outerwearColor', 'footwearColor', 'topOuterColor']) {
          for (const c of this.distinctColors[slot as keyof typeof this.distinctColors]) {
            if (c && c !== '-') this.activeColors.add(c.toLowerCase());
          }
        }
        for (const p of this.patterns) {
          this.activeColors.add(p.toLowerCase());
        }

        this.ready = true;
        console.log(`✅ AnySequenceFilterEngine initialized.`);
        resolve();
      });

      rl.on('error', reject);
    });
  }

  private ensureReady() {
    if (!this.ready) throw new Error('AnySequenceFilterEngine not initialized');
  }

  getAllUniqueColors(): ColorOption[] {
    this.ensureReady();
    const colors = new Set<string>();
    for (const slot of ['topColor', 'bottomColor', 'outerwearColor', 'footwearColor', 'topOuterColor']) {
      for (const c of this.distinctColors[slot as keyof typeof this.distinctColors]) {
        if (c && c !== '-') colors.add(c);
      }
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

  private padOptionsForAnySequence(
    currentOptions: ColorOption[],
    selections: AnySequenceContext,
    targetSlot: string,
    filters?: { occasion?: string; vibe?: string; fitType?: string }
  ): ColorOption[] {
    if (currentOptions.length >= 5) return currentOptions;

    const existingColors = new Set(currentOptions.map(o => o.color.toLowerCase()));
    const allUnique = this.getAllUniqueColors();
    const candidates: ColorOption[] = [];

    for (const item of allUnique) {
      const colorLower = item.color.toLowerCase();
      if (!existingColors.has(colorLower)) {
        // Construct hypothetical outfit to evaluate flags and scores
        const outfit = {
          topColor: targetSlot === 'topColor' ? item.color : selections.topColor,
          bottomColor: targetSlot === 'bottomColor' ? item.color : selections.bottomColor,
          outerwearColor: targetSlot === 'outerwearColor' ? item.color : selections.outerwearColor,
          footwearColor: targetSlot === 'footwearColor' ? item.color : selections.footwearColor,
          topOuterColor: targetSlot === 'topOuterColor' ? item.color : selections.topOuterColor
        };

        const flag = flagger.isFlagged(outfit);
        const { score, reasons, explanation } = scoreGarmentForAnySequence(targetSlot, item.color, selections, 0, filters);

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

    candidates.sort((a, b) => b.score - a.score);

    const padded = [...currentOptions];
    for (const cand of candidates) {
      if (padded.length >= 5) break;
      padded.push(cand);
    }
    return padded;
  }

  /**
   * Evaluates and scores options for all categories dynamically
   * based on whatever selections are currently active in the graph.
   */
  getOptionsForAnySequence(
    selections: AnySequenceContext,
    filters?: { occasion?: string; vibe?: string; fitType?: string }
  ): Record<string, ColorOption[]> {
    this.ensureReady();

    // Resolve any incoming selections containing alias colors
    const resolvedSelections: AnySequenceContext = {
      topColor: selections.topColor ? this.resolveColor(selections.topColor) : undefined,
      bottomColor: selections.bottomColor ? this.resolveColor(selections.bottomColor) : undefined,
      outerwearColor: selections.outerwearColor ? this.resolveColor(selections.outerwearColor) : undefined,
      footwearColor: selections.footwearColor ? this.resolveColor(selections.footwearColor) : undefined,
      topOuterColor: selections.topOuterColor ? this.resolveColor(selections.topOuterColor) : undefined,
    };

    const slots = ['topColor', 'bottomColor', 'outerwearColor', 'footwearColor', 'topOuterColor'];
    const result: Record<string, ColorOption[]> = {
      topColor: [],
      bottomColor: [],
      outerwearColor: [],
      footwearColor: [],
      topOuterColor: []
    };

    const hasSelections = Object.values(resolvedSelections).some(Boolean);

    // If initial color selection (no selections made yet), return all unique colors
    if (!hasSelections) {
      const allUnique = this.getAllUniqueColors();
      for (const slot of slots) {
        result[slot] = allUnique;
      }
      return result;
    }

    for (const slot of slots) {
      const activeSelections = { ...resolvedSelections };
      delete (activeSelections as any)[slot]; // score slot based on OTHER active selections

      const candidates = Array.from(this.distinctColors[slot as keyof typeof this.distinctColors]);
      const scoredList: ColorOption[] = [];

      for (const cand of candidates) {
        let combinedFreq = 0;
        for (const [selSlot, selColor] of Object.entries(activeSelections)) {
          if (selColor && selColor !== '-' && selColor !== '') {
            const freq = this.pairwiseIndex.getPairFrequency(slot, cand, selSlot, selColor);
            combinedFreq += freq;
          }
        }

        // Check if flagged
        const outfit = {
          topColor: slot === 'topColor' ? cand : resolvedSelections.topColor,
          bottomColor: slot === 'bottomColor' ? cand : resolvedSelections.bottomColor,
          outerwearColor: slot === 'outerwearColor' ? cand : resolvedSelections.outerwearColor,
          footwearColor: slot === 'footwearColor' ? cand : resolvedSelections.footwearColor,
          topOuterColor: slot === 'topOuterColor' ? cand : resolvedSelections.topOuterColor
        };

        const flag = flagger.isFlagged(outfit);
        const { score, reasons, explanation } = scoreGarmentForAnySequence(slot, cand, activeSelections, combinedFreq, filters);

        const meta = getMetadataTags(cand);
        const option: ColorOption = {
          color: cand,
          hex: this.hexIdx.getHex(cand),
          score,
          frequency: combinedFreq,
          reasons,
          occasions: meta.occasions,
          vibe: meta.vibe,
          fitType: meta.fitType,
          explanation
        };

        const colorLower = cand.toLowerCase();
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

        scoredList.push(option);
      }

      // Sort: highest score first, secondary sort by occurrence frequency, pad up to 5, and slice to 15
      const ranked = scoredList.sort((a, b) => b.score - a.score || b.frequency - a.frequency);
      const padded = this.padOptionsForAnySequence(ranked, activeSelections, slot, filters);
      result[slot] = padded.slice(0, 15);
    }

    return result;
  }
}

export const anySequenceEngine = new AnySequenceFilterEngine();
