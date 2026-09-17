# Baseline Machine Learning Model for Top Outer Color Prediction

This document describes the design, training, evaluation, and diagnostic results of the baseline multiclass classification model built to predict the perfect midlayer (`top_outer_color`) based on the remaining four outfit items (`top_color`, `bottom_color`, `outerwear_color`, and `footwear_color`).

---

## 🚀 Model Architecture & Training Setup

- **Model Type**: LightGBM Multiclass Classifier (`objective='multiclass'`)
- **Number of target classes**: 21 valid color categories (extremely rare target categories with less than 10 global samples were pruned to guarantee stratification stability).
- **Features Used (22 features)**:
  - 4 HSL Lightness indexes (one for each input garment).
  - 4 Color Family encodings (Neutral, Cool, Warm, Earth, Pastel, Pattern, mapped to `[0, 1]`).
  - 4 Position Frequency values.
  - 6 Pairwise Co-occurrence Frequency counts (top+bottom, top+jacket, etc.).
  - 4 Color Theory Harmony scores.
- **Dataset Partitioning (70 / 15 / 15 stratified split)**:
  - **Training Set**: 17,485 samples
  - **Validation Set**: 3,747 samples
  - **Test Set**: 3,747 samples

---

## 📊 Performance Metrics (Test Set Evaluated)

The model performs exceptionally well because it learns the underlying deterministic behavior of the core styling rule engine and the pre-computed recommendations.

- **Top-1 Accuracy**: **99.36%** (correctly predicts the exact color in the first choice, beating the 4.7% baseline for random choice).
- **Top-5 Accuracy**: **99.97%**
- **Top-10 Accuracy**: **100.00%**
- **Mean Average Precision (MAP)**: **0.9936**

### Per-Color Classification Accuracy (Sample)
- **Black**: 99.52% (Clean predictions)
- **Lightgrey**: 99.82%
- **Navy**: 98.21%
- **Brown**: 93.46% (Muted earth tone, slightly harder)
- **Burgundy**: 75.00% (Less common, lower count)
- **Forestgreen**: 60.00% (Muted green, lowest count)

---

## 🔍 Feature Importance Analysis

The LightGBM feature importance rankings (based on gain splits) show which features drive the model's predictions:

1. **`top_outerwear_freq`** (Gain: **634,500.56**): Joint frequency of the shirt and the jacket. It is the dominant style constraint.
2. **`outerwear_pos_freq`** (Gain: **126,102.22**): Popularity of the selected outerwear jacket.
3. **`outerwear_lightness`** (Gain: **108,827.51**): Visual contrast density of the outer jacket.
4. **`top_pos_freq`** (Gain: **87,374.51**): Relative popularity of the top color.
5. **`top_lightness`** (Gain: **66,516.37**): Shirt lightness value.
6. **`bottom_outerwear_freq`** (Gain: **59,356.03**): Correlation between trousers and the jacket.

---

## 🛠️ Error & Confusion Analysis

### Top 5 Confused Color Pairs
1. **Actual: `Brown` $\rightarrow$ Predicted: `Black`** (5 occurrences)
2. **Actual: `Black` $\rightarrow$ Predicted: `Grey`** (4 occurrences)
3. **Actual: `Black` $\rightarrow$ Predicted: `Lightgrey`** (3 occurrences)
4. **Actual: `Lightgrey` $\rightarrow$ Predicted: `Grey`** (2 occurrences)
5. **Actual: `Forestgreen` $\rightarrow$ Predicted: `Lightgrey`** (2 occurrences)

*Why does confusion happen?*
The errors occur almost entirely between similar color values in the desaturated range (neutrals like grey, black, and lightgrey) and highly desaturated earth tones (like muted browns and forest greens) where lightness overlays overlap.

---

## 📁 Model Artifacts Saved

All outputs have been generated and saved:
1. **[baseline_model.pkl](file:///Users/ayush/Coding/twelve70/baseline_model.pkl)**: Serialized model deployment package containing the LightGBM classifier, `LabelEncoder`, and `ColorFeatureEngineer` transformer.
2. **[baseline_report.json](file:///Users/ayush/Coding/twelve70/baseline_report.json)**: Structured performance report JSON.
3. **[error_analysis_report.json](file:///Users/ayush/Coding/twelve70/error_analysis_report.json)**: Detailed confusions and diagnostic recommendations JSON.
4. **[test_predictions.csv](file:///Users/ayush/Coding/twelve70/test_predictions.csv)**: Evaluation predictions on the 15% test split.
