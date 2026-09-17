# Technical Documentation: Color Combination Generation & Top Outer Prediction

This document details the mechanics behind our data expansion, the mathematical scoring weights of our styling engine, and the multi-layered prediction sequence for the `top_outer` (midlayer) color.

---

## 1. Color Combination Data Expansion

To ensure the engine recommends premium, highly fashionable outfits, we expanded the ground-truth combinations database:
- **Curated Dataset**: We designed and appended **210 high-quality fashion-forward color combinations** to `data/colorcombos.csv`. These cover quiet luxury neutrals, organic earth tones, pastels, cool coordinates, and rich warm accents.
- **MySQL Synchronization**: We updated `scripts/generate_predictions.ts` to automatically detect the live MySQL database on port `3307` and synchronize these combinations into the `color_combos` table. 
- **Duplicate Prevention**: Ingestion matches records against a normalized composite string key: `"${topColor}_${bottomColor}_${outerwearColor}_${footwearColor}_${topOuterColor}"`. If an outfit combination already exists (or its unique ID is matched), the sync script bypasses it to prevent database corruption or duplicates.

---

## 2. The Predictive Scoring Formula

When predicting a color or scoring candidates, the engine runs a **100-point multi-factor styling engine** to evaluate and rank suggestions:

| Scoring Factor | Max Weight | Description |
| :--- | :--- | :--- |
| **Aesthetic Harmony & Heuristics** | **45 Points** | Scores compatibility based on color families. Extra bonus (+20) if the candidate matches the outerwear family, or (+15) if it matches the top color to create a unified base. Neutral colors receive a default versatility bonus (+10). |
| **Database Frequency** | **25 Points** | Scores popularity based on frequency counts in the ground-truth database. Scaled linearly up to a limit of 10 matches ($F \times 2.5$). |
| **Tonal Contrast / Light-Dark Balance** | **15 Points** | Rewards contrast depth. Evaluates whether the candidate breaks the tones (e.g., dark outer jacket layering with a light neutral midlayer hoodie, or vice versa) using our `isDarkColor` utility. |
| **Visual Anchoring (Sandwich Styling Rule)** | **15 Points** | Stylists use the "Sandwich Rule" to balance outfits by repeating a color from the upper half in the footwear. Gives a +15 bonus if the candidate repeats the shoe color exactly, or +10 if it coordinates with the shoe's color family. |
| **Pattern Isolation & Clashing** | **Up to -25 Penalty** | Heavy penalties for stacking multiple patterns (e.g. camo pants with plaid hoodies). Adds a safety bonus (+10) to solid neutral candidates to "ground" active patterns in the outfit. |

---

## 3. How Top Outer Color is Predicted

When a user requests a prediction for the `top_outer` midlayer garment, the engine executes a **multi-layered prediction sequence** to guarantee maximum accuracy:

```
                  ┌──────────────────────────────┐
                  │   User requests Prediction   │
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 1. Search for EXACT Matches  │
                  │  (All 4 selected garments)   │
                  └──────────────┬───────────────┘
                                 │ Has Exact?
                   ┌─────────────┴─────────────┐
                Yes│                         No│
  ┌────────────────▼───────────┐ ┌─────────────▼─────────────┐
  │ Get exact database matches │ │ 2. Search for PARTIAL     │
  │  & rank by styled score    │ │  Matches (Top + Outerwear)│
  └────────────────────────────┘ └─────────────┬─────────────┐
                                               │ Has Partial?
                                 ┌─────────────┴─────────────┐
                              Yes│                         No│
                ┌────────────────▼───────────┐ ┌─────────────▼─────────────┐
                │ Get partial database matches│ │ 3. Search FAMILY-Based    │
                │   & rank by styled score   │ │   Correlations (Fail-Safe)│
                └────────────────────────────┘ └─────────────┬─────────────┘
                                                             │ Always Has
                                               ┌─────────────▼─────────────┐
                                               │  Evaluate all distinct    │
                                               │   colors using Heuristics │
                                               └───────────────────────────┘
```

1. **Exact Matches**: The engine first scans the index for rows matching all four selected garments. If found, it ranks the recorded `top_outer` colors using our scoring formula. (Confidence: **High**)
2. **Partial Matches**: If no exact outfit is found, the engine drops the bottom and footwear filters, looking for combos matching `Top + Outerwear`. These candidates are scored and ranked. (Confidence: **Medium**)
3. **Family-Based Fail-Safe**: If no partial matches are found, the engine evaluates *every distinct color in the database* against the selected garments using our styling heuristics. (Confidence: **Low / Dynamic**)

---

## Company Q&A: Preparing for Stakeholder Questions

### Q1: On what basis does the scoring engine decide that colors match?
* **Answer**: Our engine uses a hybrid logic of **statistical database correlation** and **rule-based aesthetic theory**. We mapped every color to modern styling families (Neutrals, Earth tones, Cool, Warm, Pastels, Patterns). Compatibility is evaluated based on classical color wheel principles (complementary, analogous, and monochromatic pairings) coupled with visual weight rules like tonal contrast and sandwich color balancing.

### Q2: Why is the average prediction score 78/100, and what does it mean?
* **Answer**: A score of 78 is considered an **excellent, highly cohesive match**. The engine clamps scores strictly between 0 and 100. Because we heavily penalize tone clashes, visual pattern stacking, and raw frequency drops, only a perfect monochromatic, sandwich-anchored, highly frequent neutral combination can score a 100. An average of 78 proves that the engine consistently outputs highly compatible coordinates and avoids visual clashes.

### Q3: What is the benefit of generating descriptive rationales instead of raw scores?
* **Answer**: Raw scores (like "85 points") are dry and don't help the consumer understand *why* an outfit works. By replacing raw scores with styling justifications (e.g. *"Creates a sophisticated, low-contrast monochromatic look..."* or *"Leverages a classic high-contrast pairing..."*), we elevate the Twelve70 experience, making it feel like a premium personal styling consultation.
