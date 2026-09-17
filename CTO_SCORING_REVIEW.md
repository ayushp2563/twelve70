# Executive Technical Review: Twelve70 Styling Scoring System

**To**: Chief Technology Officer (CTO)  
**From**: Lead Recommendation Systems Architect  
**Subject**: Outfit Styling Scoring Engine, Points Calculation Logic, and QA Flagging System  

This document provides a technical walkthrough of the Twelve70 color matching and outfit styling scoring engine. It details the exact files, functions, and mathematical rules used to rank garment options, guarantee a minimum selection pool, and eliminate/flag clashing coordinates in real time.

---

## 1. Codebase Directories & Files to Review

The scoring, padding, and flagging logic is implemented in **TypeScript** across three primary modules:

| Module / System | File Path | Key Functions to Inspect | Core Responsibility |
| :--- | :--- | :--- | :--- |
| **System 1: Sequential Engine** | [src/sequentialFilter.ts](file:///Users/ayush/Coding/twelve70/src/sequentialFilter.ts) | `scoreTopOuter()`, `padOptions()` | Calculates 100-point coordinates and pads options to a minimum of 5. |
| **System 2: Any-Sequence Engine** | [src/anySequenceFilter.ts](file:///Users/ayush/Coding/twelve70/src/anySequenceFilter.ts) | `scoreGarmentForAnySequence()`, `padOptionsForAnySequence()` | Evaluates dynamic pairwise correlations and pads options in freeform selection. |
| **Internal QA Flag System** | [src/flaggingSystem.ts](file:///Users/ayush/Coding/twelve70/src/flaggingSystem.ts) | `addFlag()`, `isFlagged()`, `syncDatabaseTable()` | Manages internal flagged combinations (database/JSON sync) and applies wildcards. |

---

## 2. Points Calculation & Mathematical Formulation

At each prediction step, the engine runs a **100-point multi-factor heuristic model** to evaluate candidate colors. The score is calculated as:

$$\text{Style Score} = \min(45, \text{Score}_{\text{Harmony}}) + \min(25, \text{Score}_{\text{Frequency}}) + \min(15, \text{Score}_{\text{Tonal}}) + \min(15, \text{Score}_{\text{Sandwich}}) + \text{Bonus}_{\text{Mono}} - \text{Penalty}_{\text{Clash}}$$

The final score is bounded strictly between `0` and `100` via:
$$\text{Final Score} = \max(0, \min(100, \text{Style Score}))$$

### A. Aesthetic Harmony / Styling Heuristics (Max: 45 Points)
Protects structural layer compatibility:
1. **Outerwear Cohesion (+20)**: Checks color family compatibility between candidate and outerwear.
   * *Same Color Family*: +20 points (e.g. Earth tone hoodie under Earth tone jacket).
   * *Harmonious Families*: +15 points (e.g. Cool tone hoodie under Neutral jacket).
2. **Underlayer Cohesion (+15)**: Checks coordination between candidate and base t-shirt.
   * *Exact Color Match*: +15 points (creates a clean, unified chest-layer flow).
   * *Harmonious Families*: +10 points.
3. **Neutral Base Bonus (+10)**: Automatically awards +10 points to Neutral families (Black, Grey, White, Camel, Tan, Charcoal) due to their default versatility.

### B. Database Frequency / Popularity (Max: 25 Points)
* Ingests occurrence frequencies from the pre-parsed ground-truth database:
  $$\text{Score}_{\text{Frequency}} = \min(F \times 2.5, 25)$$
  where $F$ is the number of times this specific pair appears in historically successful combinations.

### C. Tonal Contrast / Light-Dark Balance (Max: 15 Points)
Utilizes the lightness-based `isDarkColor` utility:
* **Tonal Break (+5)**: Awarded if candidate lightness is different from base Top lightness.
* **Outerwear Break (+5)**: Awarded if candidate lightness is different from Outerwear lightness.
* **Classic Contrast (+5)**: Awarded if candidate is a Neutral and breaks tone with a dark outerwear jacket (creates distinct visual appeal).

### D. Visual Anchoring / Sandwich Styling Rule (Max: 15 Points)
Visual weight balancing based on color repetition:
* **Exact Footwear Match (+15)**: Awarded if candidate color exactly repeats the shoe color.
* **Family Footwear Match (+10)**: Awarded if candidate and shoes share a color family.

### E. Monochromatic Styling Bonus (+15 Points)
* **Cohesion (+15)**: Awarded if the candidate, the base Top, and the Bottoms all fall into the same Neutral or Earth family.

---

## 3. Styling Explanations: Why it's Good vs. Risky

We provide users with educational, easy-to-read style critiques based on their calculated score:

### 🟢 Why a High-Score Combination is Good (Score $\ge 75$)
* **Premium Cohesion**: The outfit is perfectly balanced. Colors coordinate in a way that aligns with classical color wheel harmony.
* **Tonal Contrast**: Distinct light-under-dark layering adds visual depth, preventing the wearer from looking blocky or washed out.
* **Balanced Anchoring**: The Sandwich styling rule is active (matching shoes with an upper-half garment), drawing the overall look together.

### 🔴 Why a Low-Score Combination is Bad (Score $< 50$)
* **Visual Friction (Clashing)**: Hard clashing color families (e.g. Pastels mixed with Neon/Brights) create jarring visual competition where neither color can stand out.
* **Pattern Overload**: Stacking multiple busy patterns (e.g., plaid outerwear with camouflage underlayers) causes chaotic visual noise.
* **Flat Layering**: Wearing adjacent garments of identical lightness values results in a flat, uninspired outfit that lacks visual definition.
* **Top-Heavy Unbalance**: Omiting footwear anchoring leaves the visual weight top-heavy, making the garments look disconnected.

---

## 4. Guaranteed Color Options & Dynamic Padding

To ensure the user always has a high-quality list of coordinates (minimum of **5 options**), the engine implements a **Dynamic Padding System**:

1. **Initial Selection**: For the first choice (when no selections have been made yet), the engines retrieve **all unique colors** present in the database, allowing users the complete palette to start their outfit.
2. **Option Retrieval & Slicing**: After selecting a garment, the co-occurrence matches are calculated and ranked.
3. **Fallback Fall-through**: If the ranked direct database matches yield **fewer than 5 candidates**, the `padOptions` helper fetches alternative colors from the database.
4. **Heuristic Scoring on Fallbacks**: These fallback colors are run through the core 100-point styling heuristics (scoring with a database frequency $F = 0$). This ensures clashing or poorly coordinated fallback colors are penalized and pushed to the bottom, while high-harmony, versatile neutrals are promoted to fill the remaining slots up to the minimum of 5.

---

## 5. Internal QA Testing Flag System

We have implemented an **Internal Flag System** for the style and testing teams to tag combinations as "not good" during live testing. 

### A. Dual Storage & Sync
Flagged combinations are persisted in two synchronized locations:
1. **Local JSON Store (`data/flagged_outfits.json`)**: Allows developers to easily read, inspect, and version-control flagged combinations directly in Git.
2. **Database Table (`flagged_combinations`)**: Automatically verified and synchronized at startup. Tester flags are inserted into a dedicated SQL table for central query analytics.

### B. Wildcard/Partial Matches
The flagging matching algorithm supports partial wildcards. If a tester flags:
* `topColor: "red"`, `bottomColor: "neongreen"` (and leaves others empty), **any** outfit containing a red top and neon green bottoms is automatically flagged.
* A complete 5-garment outfit, then **only** that exact combination is flagged.

### C. Exclusions & UI Banners
When a color option is flagged:
1. **Exclusion / Penalty**: Its score is immediately overridden to a baseline of `5/100`, pushing it out of the normal recommendations list to the bottom.
2. **Stylist warning**: Its styling reasons are prepended with an explicit alert: `⚠️ Style Alert: [Reason entered by tester]`.
3. **Dedicated UI Banner**: On both the Sequential and Any-Sequence frontends, these flagged combinations are dynamically rendered in a separate section under a prominent banner:
   `⚠️ Less Matched Combinations (Style Team Flagged: Will not look good on you)`.

---

## 6. TypeScript Highlight: Dynamic Padding & Flag Evaluation

Below is the core implementation of options ranking, flag verification, and padding (from [src/sequentialFilter.ts](file:///Users/ayush/Coding/twelve70/src/sequentialFilter.ts)):

```typescript
  private padOptions(
    currentOptions: ColorOption[],
    ctx: ScoringContext,
    targetSlot: 'topColor' | 'bottomColor' | 'outerwearColor' | 'footwearColor' | 'topOuterColor'
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
        const { score, reasons } = scoreTopOuter(item.color, ctx, 0);

        const option: ColorOption = {
          color: item.color,
          hex: this.hexIdx.getHex(item.color),
          score,
          frequency: 0,
          reasons: [...reasons, 'Alternative style suggestion to expand your options']
        };

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
```
