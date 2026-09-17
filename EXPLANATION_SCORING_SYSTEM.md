# Technical Documentation: Outfit Styling Scoring & Clashing Elimination Engine

This document provides a comprehensive breakdown of the Twelve70 Outfit Builder's styling scoring algorithms, how the system mathematically eliminates unharmonious or clashing combinations, and how the scoring engine behaves across both active engines.

---

## 1. How the Scoring System is Structured

To deliver premium, personal-stylist-grade recommendations, our scoring engine runs a **100-point multi-factor styling system** to evaluate outfit coordinates. This system translates classical aesthetic color theory and styling guidelines into mathematical operations:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      100-POINT COMPATIBILITY SCORE                     │
├─────────────────────────────────────┬──────────────────────────────────┤
│ 1. Aesthetic Heuristics  (45 pts)   │ 2. Database Frequency  (25 pts)  │
│    - Neutral Base (+10)             │    - Ground-truth Popularity     │
│    - Outerwear Harmony (+20)        │                                  │
│    - Underlayer Cohesion (+15)      │                                  │
├─────────────────────────────────────┼──────────────────────────────────┤
│ 3. Tonal Contrast        (15 pts)   │ 4. Sandwich Anchoring  (15 pts)  │
│    - Light-Under-Dark Layering      │    - Repeating Top in Footwear   │
├─────────────────────────────────────┴──────────────────────────────────┤
│ 5. Clashing & Pattern Penalties (Up to -25 pts)                        │
│    - Color Clashing (-20)  - Multi-pattern Stacking (-25)              │
└────────────────────────────────────────────────────────────────────────┘
```

### A. Core Styling Heuristics (Max: 45 Points)
This factor prioritizes classical color coordination rules:
- **Outerwear Cohesion (+20)**: The jacket is the most visible layer. If the candidate color matches the color family of the outerwear, we award +20 points.
- **Underlayer Harmony (+15)**: The midlayer sweater/hoodie should coordinate cleanly with the base t-shirt. Matching the top color exactly earns +15; matching its family coordinates earns +10.
- **Neutral Base Versatility (+10)**: Neutral colors (Black, Grey, White, Camel, Tan, Charcoal) are mathematically versatile. They receive an automatic +10 point boost.

### B. Database Frequency (Max: 25 Points)
Statistical popularity in historical curation:
- Evaluates how often this specific color pairing has appeared in historically successful ground-truth combinations.
- Scaled linearly: $\text{Freq Score} = \min(F \times 2.5, 25)$ where $F$ is the co-occurrence frequency in the database index.

### C. Tonal Contrast / Light-Dark Balance (Max: 15 Points)
Lightness contrast adds visual depth to layered outfits:
- Evaluates whether the candidate breaks the tones (e.g. wearing a light neutral hoodie under a dark charcoal coat).
- Gives +5 points for a tonal contrast break between top and midlayer, +5 points for a break between outerwear and midlayer, and a +5 point bonus for classic light-under-dark neutral layering.

### D. Visual Anchoring / Sandwich Styling Rule (Max: 15 Points)
The **Sandwich Rule** is a fundamental styling guideline: balance the visual weight of an outfit by repeating a color from the upper half in your footwear.
- Gives a **+15 point bonus** if the candidate color matches the footwear color exactly.
- Gives a **+10 point bonus** if they share the same color family.

---

## 2. How the System Eliminates "Wrong" Combinations

Rather than relying on vague filters, the system mathematically suppresses "wrong" or unharmonious combinations to push them to the absolute bottom of the recommendation list:

### A. Color Family Clashing Penalties
We map every color into distinct color families (Neutrals, Warm, Cool, Earth, Pastels, Patterns). We define an explicit **Clash Table** of families that create unpleasant visual tension:
- **Pastels vs. Warm/Brights**: Stacking soft mint or light pink with aggressive neon or warm red causes visual friction.
- **The Penalty**: If a candidate color family clashes with either the outerwear or bottom color, a **-20 point penalty** is immediately deducted, pushing the candidate to the bottom of the list.

### B. Pattern Stacking Elimination
Stacking multiple patterned garments (e.g. pairing a camouflage jacket with a plaid hoodie and tartan pants) is a major styling mistake.
- **The Penalty**: If the user has *already* selected any patterned garment (Top, Bottom, or Outerwear), any patterned candidate triggers a massive **-25 point penalty**.
- **Solid Neutral Grounding Bonus (+10)**: To actively guide the user away from chaotic patterns, if a patterned garment is selected in the outfit, all solid neutral candidates receive a **+10 point grounding bonus** to anchor the visual clutter with clean solids.

---

## 3. How Scoring Works Across Both Engines

Our two engines leverage the exact same core styling database and family mappings but apply the scoring rules in different mathematical contexts:

### System 1: The Sequential Outfit Filter
- **Context**: User is guided in a strict path: `Top → Bottom → Outerwear → Footwear`.
- **How it works**:
  1. **Retrieval Step**: The engine queries the database index for combinations matching the exact selected colors up to the current step.
  2. **Frequency Count**: It tallies how many times each candidate color appears in those matching configurations.
  3. **Heuristics Scoring**: The retrieved candidate list is fed to `scoreTopOuter()`. The engine calculates the 100-point styling scores, ranks them, and serves the top options to the user.

### System 2: The Any-Sequence Pairwise Graph Engine
- **Context**: User is free to select any subset of slots in any order. The exact match space is often empty (sparsity).
- **How it works**:
  1. **Pairwise Graph Decomposition**: Selections are treated as active nodes in an outfit graph.
  2. **Joint Frequency Evaluation**: For a candidate color in an unselected slot (e.g. Bottom), the engine checks its pairwise frequency against *each active selection independently* (e.g. `Freq(bottom, top)` + `Freq(bottom, shoes)`).
  3. **Heuristic Blending**: These pairwise correlations are summed and passed to `scoreGarmentForAnySequence()`, combining dynamic pairwise database frequencies with tone contrast, sandwich anchoring, and pattern protection based on whatever nodes are active in the graph.

---

## 4. The Stage 2: Machine Learning Re-Ranking Layer

To personalize and optimize the recommendations further, both engines mount a **Stage 2 Machine Learning Re-Ranker** loaded directly inside Express via the ONNX Runtime:

```
┌──────────────────────────────┐
│   STAGE 1: GRAPH RETRIEVAL   │
│  (System 1 & 2 Candidates)   │
└──────────────┬───────────────┘
               │ Outputs candidates in <2ms
┌──────────────▼───────────────┐
│   STAGE 2: FEATURE EXTRACTOR │  (Lightness contrast, color hashes,
│    (Feature Vector Hydration)│   seasonality, user preferences)
└──────────────┬───────────────┘
               │ Batched 2D Tensor
┌──────────────▼───────────────┐
│       STAGE 3: ML RANKER     │  (LightGBM GBDT LambdaRank runs
│     (ONNX Runtime Session)   │   in under 1.5ms)
└──────────────┬───────────────┘
               │ Output utilities
┌──────────────▼───────────────┐
│     STAGE 4: HYBRID BLEND    │  (Score = 40% Graph + 60% ML)
└──────────────────────────────┘
```

- **The Score Blend**:
  
  $$\text{Final Score} = 0.4 \cdot \text{Score}_{\text{Graph}} + 0.6 \cdot \text{Normalized Score}_{\text{ML}}$$
  
- **MinMax Normalization**: Since raw ML utilities are relative float values, the engine applies MinMax normalization across the candidate batch, mapping the model's output cleanly to the 0–100 scale, and appends `ML Rank Optimizer (Affinity Utility: Xpts)` directly to the UI rationales.
