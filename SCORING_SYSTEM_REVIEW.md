
This document provides a technical walkthrough of the Twelve70 color matching and outfit styling scoring engine. It details the exact files, functions, and mathematical rules used to rank garment options and eliminate clashing coordinates in real time.

---

## 1. Codebase Directories & Files to Review

The scoring logic is implemented in **TypeScript** across two independent candidate-generation engines:

| Module / System | File Path | Key Functions to Inspect | Line Range | Core Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| **System 1: Sequential Engine** | [sequentialFilter.ts] | `scoreTopOuter()` | `328–470` | Calculates 100-point coordinates for sequential step-by-step outfit prediction. |
| **System 2: Any-Sequence Engine** | [anySequenceFilter.ts] | `scoreGarmentForAnySequence()` | `141–266` | Evaluates dynamic pairwise correlations across active graph nodes in freeform selection. |

---

## 2. Points Calculation & Mathematical Formulation

At each prediction step, the engine runs a **100-point multi-factor heuristic model** to evaluate candidate colors. The score is calculated as:

$$\text{Style Score} = \min(45, \text{Score}_{\text{Harmony}}) + \min(25, \text{Score}_{\text{Frequency}}) + \min(15, \text{Score}_{\text{Tonal}}) + \min(15, \text{Score}_{\text{Sandwich}}) + \text{Bonus}_{\text{Mono}} - \text{Penalty}_{\text{Clash}}$$

The final score is bounded strictly between `0` and `100` via:
$$\text{Final Score} = \max(0, \min(100, \text{Style Score}))$$

### A. Aesthetic Harmony / Styling Heuristics (Max: 45 Points)
Protects structural layer compatibility:
1.  **Outerwear Cohesion (+20)**: Checks color family compatibility between candidate and outerwear.
    - *Same Color Family*: +20 points (e.g. Earth tone hoodie under Earth tone jacket).
    - *Harmonious Families*: +15 points (e.g. Cool tone hoodie under Neutral jacket).
2.  **Underlayer Cohesion (+15)**: Checks coordination between candidate and base t-shirt.
    - *Exact Color Match*: +15 points (creates a clean, unified chest-layer flow).
    - *Harmonious Families*: +10 points.
3.  **Neutral Base Bonus (+10)**: Automatically awards +10 points to Neutral families (Black, Grey, White, Camel, Tan, Charcoal) due to their default versatility.

### B. Database Frequency / Popularity (Max: 25 Points)
- Ingests occurrence frequencies from the pre-parsed ground-truth database:
  $$\text{Score}_{\text{Frequency}} = \min(F \times 2.5, 25)$$
  where $F$ is the number of times this specific pair appears in historically successful combinations.

### C. Tonal Contrast / Light-Dark Balance (Max: 15 Points)
Utilizes the lightness-based `isDarkColor` utility:
- **Tonal Break (+5)**: Awarded if candidate lightness is different from base Top lightness.
- **Outerwear Break (+5)**: Awarded if candidate lightness is different from Outerwear lightness.
- **Classic Contrast (+5)**: Awarded if candidate is a Neutral and breaks tone with a dark outerwear jacket (creates distinct visual appeal).

### D. Visual Anchoring / Sandwich Styling Rule (Max: 15 Points)
Visual weight balancing based on color repetition:
- **Exact Footwear Match (+15)**: Awarded if candidate color exactly repeats the shoe color.
- **Family Footwear Match (+10)**: Awarded if candidate and shoes share a color family.

### E. Monochromatic Styling Bonus (+15 Points)
- **Cohesion (+15)**: Awarded if the candidate, the base Top, and the Bottoms all fall into the same Neutral or Earth family.

---

## 3. Clashing Prevention & Pattern Elimination Logic

We protect styling guidelines by mathematically penalizing and suppressing unharmonious configurations, pushing them to the bottom of the list.

### A. Color Family Clashing (-20 Points)
We define an explicit **Clash Table** (e.g., Pastels vs. Warm/Neons). If a candidate color family matches a clash constraint with the active Outerwear or Bottoms:
- **Deduction**: `-20 points` (Sequential) or `-20 points` (Any-Sequence).

### B. Multi-Pattern Stacking Prevention (-25 Points)
Stacking busy patterns (such as houndstooth, camo, plaid, or tartan) is heavily penalized:
- **Deduction**: If the user has already selected *any* patterned garment, any patterned candidate triggers a **-25 point penalty**.
- **Solid Grounding Bonus (+10)**: If a pattern is active in the outfit, all solid neutral candidates receive a **+10 point bonus** to ground the visual clutter.

---

## 4. Code Block Highlight: Core Scoring Implementation

Here is the exact implementation of the 100-point scoring algorithm (from [src/sequentialFilter.ts](file:///Users/ayush/Coding/twelve70/src/sequentialFilter.ts)):

```typescript
function scoreTopOuter(candidate: string, ctx: ScoringContext, frequency: number): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const candFam = getFamily(candidate);

  // 1. DB Frequency (0–25 pts)
  const freqScore = Math.min(frequency * 2.5, 25);
  score += freqScore;

  // 2. Aesthetic Harmony / Heuristics (0–45 pts)
  let harmonyScore = 0;
  if (ctx.outerwearColor) {
    const owFam = getFamily(ctx.outerwearColor);
    if (candFam === owFam) {
      harmonyScore += 20;
    } else if (isHarmonious(candFam, owFam)) {
      harmonyScore += 15;
    }
  }
  if (ctx.topColor) {
    const topFam = getFamily(ctx.topColor);
    if (candidate.toLowerCase() === ctx.topColor.toLowerCase()) {
      harmonyScore += 15;
    } else if (isHarmonious(candFam, topFam)) {
      harmonyScore += 10;
    }
  }
  if (candFam === ColorFamily.NEUTRAL) {
    harmonyScore += 10;
  }
  score += Math.min(harmonyScore, 45);

  // 3. Tonal Contrast (0–15 pts)
  let tonalScore = 0;
  const candDark = isDarkColor(candidate);
  if (ctx.topColor) {
    const topDark = isDarkColor(ctx.topColor);
    if (candDark !== topDark) tonalScore += 5;
  }
  if (ctx.outerwearColor) {
    const owDark = isDarkColor(ctx.outerwearColor);
    if (candDark !== owDark) {
      tonalScore += 5;
      if (candFam === ColorFamily.NEUTRAL) tonalScore += 5;
    }
  }
  score += Math.min(tonalScore, 15);

  // 4. Visual Anchoring (Sandwich Rule) (0–15 pts)
  let sandwichScore = 0;
  if (ctx.footwearColor) {
    const fwFam = getFamily(ctx.footwearColor);
    if (candidate.toLowerCase() === ctx.footwearColor.toLowerCase()) {
      sandwichScore += 15;
    } else if (candFam === fwFam) {
      sandwichScore += 10;
    }
  }
  score += Math.min(sandwichScore, 15);

  // 5. Monochromatic Rule (+15 pts)
  if (ctx.topColor && ctx.bottomColor) {
    const topFam = getFamily(ctx.topColor);
    const botFam = getFamily(ctx.bottomColor);
    if (candFam === topFam && candFam === botFam && 
       (candFam === ColorFamily.NEUTRAL || candFam === ColorFamily.EARTH)) {
      score += 15;
    }
  }

  // 6. Pattern Protection & Clashing Penalties (Up to -25 pts)
  let clashPenalty = 0;
  if (ctx.outerwearColor && isClash(candFam, getFamily(ctx.outerwearColor))) {
    clashPenalty += 15;
  }
  if (ctx.bottomColor && isClash(candFam, getFamily(ctx.bottomColor))) {
    clashPenalty += 10;
  }
  const hasPattern = [ctx.topColor, ctx.bottomColor, ctx.outerwearColor]
    .filter(Boolean)
    .some(c => getFamily(c!) === ColorFamily.PATTERN);
  if (hasPattern) {
    if (candFam === ColorFamily.PATTERN) clashPenalty += 25;
    else if (candFam === ColorFamily.NEUTRAL) score += 10;
  }
  score -= Math.min(clashPenalty, 25);

  return { score: Math.max(0, Math.min(100, score)), reasons };
}
```
