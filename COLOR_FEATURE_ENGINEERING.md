# Color Feature Engineering System

This system maps color names into continuous and categorical numerical representations based on color theory, visual properties, and joint co-occurrence counts calculated from historical data. These features enable machine learning models (like Random Forests or Gradient Boosted Trees) to capture styling affinity and rules.

---

## 🚀 Mappings Provided

Two JSON configuration files have been checked into the root repository:

1. **[color_families.json](file:///Users/ayush/Coding/twelve70/color_families.json)**:
   - Maps each of the 160 distinct colors/textures to one of the six core styling families: `Neutral`, `Warm`, `Cool`, `Earth`, `Pastel`, or `Pattern`.
   - Examples:
     - `"Black"`: `Neutral`
     - `"Camel"`: `Neutral`
     - `"Olivegreen"`: `Earth`
     - `"Navy"`: `Cool`
     - `"Bred"`: `Warm`
     - `"Blackwatchtartan"`: `Pattern`

2. **[color_lightness.json](file:///Users/ayush/Coding/twelve70/color_lightness.json)**:
   - Contains a normalized lightness score in `[0, 1]`. 
   - Computed deterministically using the standard **HSL Lightness formula** `(max(R, G, B) + min(R, G, B)) / 2.0` from hex values registered in `colorshex.csv`.
   - Examples:
     - `"Black"`: `0.0`
     - `"Charcoal"`: `0.302`
     - `"Camel"`: `0.639`
     - `"White"`: `1.0`
     - `"Offwhite"`: `0.939`
     - Patterns default to the dominant background or base shade.

---

## 🔍 Feature Extraction Pipeline (`feature_engineer.py`)

The script **[feature_engineer.py](file:///Users/ayush/Coding/twelve70/feature_engineer.py)** extracts exactly **30 continuous features** normalized between `0.0` and `1.0` for any outfit combination:

1. **Lightness Features** (5 features):
   - Continuous lightness index `[0, 1]` for each slot (`top_lightness`, `bottom_lightness`, `outerwear_lightness`, `shoes_lightness`, `midlayer_lightness`).
2. **Color Family Numeric** (5 features):
   - Category mapping normalized to `[0, 1]`:
     - `Neutral` $\rightarrow$ `0.0`
     - `Warm` $\rightarrow$ `0.2`
     - `Cool` $\rightarrow$ `0.4`
     - `Earth` $\rightarrow$ `0.6`
     - `Pastel` $\rightarrow$ `0.8`
     - `Pattern` $\rightarrow$ `1.0`
3. **Position Frequency Features** (5 features):
   - Historical popularity score of each color inside its specific slot (e.g. `top_pos_freq`, `bottom_pos_freq`), normalized by maximum position occurrence.
4. **Pairwise Co-occurrence Frequency** (10 features):
   - Joint co-occurrence rates between all 10 garment pairs (e.g. `top_shoes_freq`, `top_bottom_freq`, etc.), representing statistical styling combinations.
5. **Color Family Harmony Scores** (5 features):
   - Computes the ratio of other garments in the outfit whose color families are listed as harmonious with the target garment's family in the Twelve70 styling rules.

---

## 📊 Feature Importance Analysis

To evaluate which features are most predictive, we trained a Random Forest model on positive outfit records (`is_clean` combinations from `cleaned_outfits.csv`) against synthetically generated negative samples (shuffled invalid combinations).

### Model Performance
- **Classifier**: Random Forest Classifier (100 estimators, max depth 10)
- **Classification Accuracy**: **75.03%** on out-of-sample test splits, indicating that the engineered features contain a strong signal for valid styling.

### Group Importance Summary

| Feature Category | Cumulative Importance | Description |
| :--- | :--- | :--- |
| **Pairwise Co-occurrence Frequency** | **85.10%** | Joint co-occurrence frequencies between color pairs (e.g., top + shoes, top + bottom). |
| **Position Frequency** | **9.29%** | Individual color popularity per slot (e.g., top, bottom). |
| **Lightness (0-1)** | **2.96%** | Visual contrast and light-dark balance between layers. |
| **Color Family (Label Encoded)** | **1.73%** | Representation of color families (Neutrals, Cools, Warms, etc.). |
| **Color Family Harmony Score** | **0.92%** | Explicit color theory logic matching. |

### Top Individual Features

1. **`top_shoes_freq`** (Importance: **23.44%**): Captures the standard "Sandwich Styling Rule" (coordination between shirt and footwear colors).
2. **`top_bottom_freq`** (Importance: **15.88%**): Direct color pairing between the top and bottom layer.
3. **`top_outerwear_freq`** (Importance: **12.49%**): Core visual combination of shirt and jacket.
4. **`bottom_shoes_freq`** (Importance: **11.56%**): Color correlation between trousers and footwear.
5. **`bottom_outerwear_freq`** (Importance: **9.23%**): Color match between pants and outer jackets.
