/**
 * ============================================================================
 * MACHINE LEARNING FEATURE EXTRACTOR
 * ============================================================================
 *
 * Purpose : Extracts and normalizes real-time features from outfit candidates,
 *           active selections, and contextual metadata, transforming them into
 *           numerical arrays suitable for ONNX decision-tree inference.
 * ============================================================================
 */

import { ColorOption, getFamily, isDarkColor, ColorFamily } from '../sequentialFilter';

// Standardized list of features processed by the XGBoost / LightGBM model
export const FEATURE_NAMES = [
  'topColorIdx',
  'bottomColorIdx',
  'outerwearColorIdx',
  'footwearColorIdx',
  'candidateColorIdx',
  'pairwiseFreq',
  'tonalContrast',
  'userColorAffinity',
  'seasonIdx'
];

export interface FeatureExtractionContext {
  topColor?: string;
  bottomColor?: string;
  outerwearColor?: string;
  footwearColor?: string;
  topOuterColor?: string;
  userId?: string;
  /**
   * Normalized 0..1 affinity per color from the user's profile summary
   * (share of the user's historical saves per midlayer color). When absent,
   * a neutral default is used.
   */
  colorAffinity?: Record<string, number>;
}

/**
 * Maps a color name string to a deterministic integer hash index (0 to 49)
 * for model consumption (Decision Trees handle categorical splits natively).
 */
export function hashColorToIdx(colorName: string | undefined): number {
  if (!colorName || colorName === '-' || colorName === '') return 0;
  const normalized = colorName.toLowerCase().replace(/[-_\s]/g, '');
  
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 50; // Map to 50 distinct color buckets
}

/**
 * Calculates a tonal contrast score between garments (1.0 for high contrast light-dark, 0.0 for low contrast)
 */
export function calculateTonalContrast(colorA: string | undefined, colorB: string | undefined): number {
  if (!colorA || !colorB || colorA === '-' || colorB === '-') return 0.5;
  const darkA = isDarkColor(colorA);
  const darkB = isDarkColor(colorB);
  return darkA !== darkB ? 1.0 : 0.0;
}

/**
 * Extracts a flat numerical feature vector array for a single candidate garment
 */
export function extractCandidateFeatureArray(
  candidate: ColorOption,
  ctx: FeatureExtractionContext,
  targetSlot: string
): number[] {
  // 1. Categorical color hashes
  const topColorIdx      = hashColorToIdx(ctx.topColor);
  const bottomColorIdx   = hashColorToIdx(ctx.bottomColor);
  const outerwearColorIdx = hashColorToIdx(ctx.outerwearColor);
  const footwearColorIdx  = hashColorToIdx(ctx.footwearColor);
  const candidateColorIdx = hashColorToIdx(candidate.color);

  // 2. Graph pairwise frequency
  const pairwiseFreq = candidate.frequency || 0;

  // 3. Tonal Contrast: contrast between candidate and outerwear or top
  let tonalContrast = 0.5;
  if (targetSlot === 'topOuterColor' || targetSlot === 'topColor') {
    if (ctx.outerwearColor) {
      tonalContrast = calculateTonalContrast(candidate.color, ctx.outerwearColor);
    }
  } else if (targetSlot === 'outerwearColor') {
    if (ctx.topColor) {
      tonalContrast = calculateTonalContrast(candidate.color, ctx.topColor);
    }
  }

  // 4. Personalization User Affinity: from the user's rolled-up profile
  // (share of their historical saves for this candidate color). Falls back
  // to a neutral coefficient for anonymous users / users with no history.
  let userColorAffinity = 0.8; // Safe versatile default
  if (ctx.colorAffinity) {
    const key = (candidate.color || '').toLowerCase().trim();
    userColorAffinity = ctx.colorAffinity[key] ?? 0.1;
  }

  // 5. Context Seasonality: sine wave encoding of current month to capture warmth
  const month = new Date().getMonth();
  const seasonIdx = Math.sin((month / 12) * Math.PI * 2); // Sine wave seasonality

  // Return flat array in exact index sequence matching LightGBM input
  return [
    topColorIdx,
    bottomColorIdx,
    outerwearColorIdx,
    footwearColorIdx,
    candidateColorIdx,
    pairwiseFreq,
    tonalContrast,
    userColorAffinity,
    seasonIdx
  ];
}
