#!/usr/bin/env python3
"""
generate_error_analysis.py

Deep error analysis of the tuned LightGBM midlayer model, computed from REAL
model predictions on the held-out test split (the same 70/15/15 stratified
split used during hyperparameter optimization, reproduced with the same seed).

No simulated accuracies, confidences, or labels are used anywhere.
"""
import os
import sys
import json
import pickle
import numpy as np
import pandas as pd
from collections import Counter
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

def load_json_mapping(filepath):
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Mapping file not found: {filepath}")
    with open(filepath, 'r') as f:
        data = json.load(f)
    return {k.lower(): v for k, v in data.items()}

INPUT_COLS = ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color']

def main():
    print("🔮 Starting Deep Error Analysis Pipeline (real evaluation)...")

    # 1. Load mappings and model
    families_map = load_json_mapping('color_families.json')
    lightness_map = load_json_mapping('color_lightness.json')

    model_path = 'tuned_model.pkl'
    if not os.path.exists(model_path):
        print(f"❌ Error: {model_path} not found. Run optimize_hyperparameters.py first.")
        sys.exit(1)

    with open(model_path, 'rb') as f:
        deployment = pickle.load(f)

    model = deployment['model']
    engineer = deployment['feature_engineer']
    classes_list = deployment['classes']

    # 2. Load dataset and reproduce the exact train/val/test split used in training
    data_path = 'cleaned_predictions.csv'
    if not os.path.exists(data_path):
        print(f"❌ Error: {data_path} not found.")
        sys.exit(1)

    df_raw = pd.read_csv(data_path)
    df_raw['target_color'] = df_raw['top_outer_color'].where(df_raw['top_outer_color'] != '-', df_raw['predicted_top_outer_color'])
    df_raw['target_color'] = df_raw['target_color'].astype(str).str.strip().str.lower()
    for col in INPUT_COLS:
        df_raw[col] = df_raw[col].astype(str).str.strip().str.lower()

    class_counts = df_raw['target_color'].value_counts()
    frequent_classes = class_counts[class_counts >= 10].index
    df_filtered = df_raw[df_raw['target_color'].isin(frequent_classes)].copy().reset_index(drop=True)

    le = LabelEncoder()
    df_filtered['target_encoded'] = le.fit_transform(df_filtered['target_color'])
    if list(le.classes_) != list(classes_list):
        print("⚠️  Warning: reconstructed class list differs from the model's class list.")

    y = df_filtered['target_encoded']
    X_indices = pd.Series(df_filtered.index)
    train_idx, temp_idx, y_train, y_temp = train_test_split(
        X_indices, y, test_size=0.30, random_state=42, stratify=y
    )
    val_idx, test_idx, y_val, y_test = train_test_split(
        temp_idx, y_temp, test_size=0.50, random_state=42, stratify=y_temp
    )
    df_sample = df_filtered.loc[test_idx].copy().reset_index(drop=True)
    n_test = len(df_sample)
    print(f"   Held-out test split reproduced: {n_test} rows")

    # 3. Real predictions and confidences
    X = engineer.transform(df_sample)
    probs = model.predict(X)

    pred_indices = np.argmax(probs, axis=1)
    predicted_colors = [classes_list[idx] for idx in pred_indices]
    confidences = np.max(probs, axis=1)

    actual_colors = df_sample['target_color'].tolist()
    correct_flag = [int(p == a) for p, a in zip(predicted_colors, actual_colors)]

    df_sample['predicted_color'] = predicted_colors
    df_sample['actual_color'] = actual_colors
    df_sample['confidence'] = confidences
    df_sample['correct'] = correct_flag

    correct_count = sum(correct_flag)
    accuracy = correct_count / n_test
    print(f"   Real test accuracy: {correct_count}/{n_test} = {accuracy:.4f}")

    # 4. Outfit-category detectors
    def is_monochromatic(row):
        fams = [families_map.get(row[col], 'Neutral') for col in INPUT_COLS]
        counts = Counter(fams)
        return int(max(counts.values()) >= 3)

    def is_contrast(row):
        dark_subs = ['black', 'dark', 'charcoal', 'navy', 'indigo', 'burgundy', 'maroon', 'oxblood', 'tobacco', 'brown', 'forest', 'olive', 'midnight']
        light_subs = ['light', 'white', 'sand', 'sail', 'photondust', 'mint', 'lavender', 'sage', 'beige']

        has_dark = False
        has_light = False
        for col in INPUT_COLS:
            c = row[col]
            if any(sub in c for sub in light_subs):
                has_light = True
            elif any(sub in c for sub in dark_subs) or 'grey' in c or 'gray' in c:
                has_dark = True
        return int(has_dark and has_light)

    def is_rare_combo(row):
        rare_colors = ['burgundy', 'mustard', 'gold', 'sage', 'rust', 'coral', 'deeppurple', 'lavender', 'mint', 'orange']
        return int(any(row[col] in rare_colors for col in INPUT_COLS))

    # 5. Confusion Matrix (CSV)
    print("📊 Computing confusion matrix...")
    cm_df = pd.crosstab(
        pd.Series(actual_colors, name='Actual'),
        pd.Series(predicted_colors, name='Predicted')
    )
    cm_df = cm_df.reindex(index=classes_list, columns=classes_list, fill_value=0)
    cm_df.to_csv('confusion_matrix.csv')
    print("✅ Saved confusion_matrix.csv")

    # 6. Per-Color Accuracy (real)
    per_color_acc = {}
    per_color_support = {}
    for c in classes_list:
        color_samples = df_sample[df_sample['actual_color'] == c]
        per_color_support[c.title()] = len(color_samples)
        if len(color_samples) > 0:
            per_color_acc[c.title()] = round(float(color_samples['correct'].mean()), 4)
    sorted_per_color_acc = {k: v for k, v in sorted(per_color_acc.items(), key=lambda item: item[1], reverse=True)}

    # 7. Confidence Analysis (real)
    high_conf_thresh = np.percentile(confidences, 80)
    low_conf_thresh = np.percentile(confidences, 20)

    high_conf = df_sample[df_sample['confidence'] >= high_conf_thresh]
    low_conf = df_sample[df_sample['confidence'] <= low_conf_thresh]

    high_conf_correct = round(float(high_conf['correct'].mean()), 4)
    low_conf_correct = round(float(low_conf['correct'].mean()), 4)

    # Real binned calibration curve (5 equal-width confidence bins)
    bins = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]
    bin_labels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%']
    calibration_bins = []
    for lo, hi, label in zip(bins[:-1], bins[1:], bin_labels):
        mask = (df_sample['confidence'] >= lo) & (df_sample['confidence'] < hi)
        subset = df_sample[mask]
        calibration_bins.append({
            "bin": label,
            "count": int(len(subset)),
            "empirical_accuracy": round(float(subset['correct'].mean()), 4) if len(subset) > 0 else None
        })

    # 8. Error Patterns Grouping (real accuracies per category)
    df_sample['monochromatic'] = df_sample.apply(is_monochromatic, axis=1)
    df_sample['contrast'] = df_sample.apply(is_contrast, axis=1)
    df_sample['rare_combo'] = df_sample.apply(is_rare_combo, axis=1)

    def category_acc(mask_col):
        subset = df_sample[df_sample[mask_col] == 1]
        if len(subset) == 0:
            return None, 0
        return round(float(subset['correct'].mean()), 4), len(subset)

    mono_acc, mono_n = category_acc('monochromatic')
    contrast_acc, contrast_n = category_acc('contrast')
    rare_acc, rare_n = category_acc('rare_combo')

    # 9. Top confusion pairs (real)
    top_confusion_pairs = []
    cm_masked = cm_df.copy()
    for col in cm_masked.columns:
        if col in cm_masked.index:
            cm_masked.loc[col, col] = 0

    confusion_stacked = cm_masked.stack().reset_index()
    confusion_stacked.columns = ['Actual', 'Predicted', 'Count']
    confusion_stacked = confusion_stacked[confusion_stacked['Count'] > 0]
    confusion_stacked = confusion_stacked.sort_values(by='Count', ascending=False).head(10)

    for _, row in confusion_stacked.iterrows():
        top_confusion_pairs.append({
            "actual": row['Actual'].title(),
            "predicted": row['Predicted'].title(),
            "count": int(row['Count'])
        })

    error_analysis_report = {
        "evaluation": "Real predictions on held-out 15% test split (no simulation)",
        "total_predictions": n_test,
        "correct": correct_count,
        "incorrect": n_test - correct_count,
        "accuracy": round(accuracy, 4),
        "top_confusion_pairs": top_confusion_pairs,
        "per_color_accuracy": sorted_per_color_acc,
        "per_color_test_support": per_color_support,
        "confidence_analysis": {
            "high_confidence_correct": high_conf_correct,
            "low_confidence_correct": low_conf_correct,
            "confidence_calibration": "GOOD" if high_conf_correct > low_conf_correct else "POOR",
            "calibration_bins": calibration_bins
        },
        "error_patterns": {
            "monochromatic_outfits": {"accuracy": mono_acc, "test_support": mono_n},
            "contrast_outfits": {"accuracy": contrast_acc, "test_support": contrast_n},
            "rare_color_combinations": {"accuracy": rare_acc, "test_support": rare_n}
        }
    }

    with open('error_analysis_report.json', 'w') as f:
        json.dump(error_analysis_report, f, indent=2)
    print("✅ Saved error_analysis_report.json")

    # 10. Hardest Cases (real high-confidence mistakes)
    print("🚨 Identifying hardest cases (high confidence mistakes)...")
    incorrect_df = df_sample[df_sample['correct'] == 0].copy()

    actual_ranks = []
    for idx, row in incorrect_df.iterrows():
        sorted_indices = np.argsort(probs[idx])[::-1]
        sorted_classes = [classes_list[c_idx] for c_idx in sorted_indices]
        try:
            rank = sorted_classes.index(row['actual_color']) + 1
            suffix = 'th' if 11 <= rank <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(rank % 10, 'th')
            actual_ranks.append(f"{rank}{suffix}")
        except ValueError:
            actual_ranks.append("n/a")

    incorrect_df['Actual_Rank'] = actual_ranks
    incorrect_df['Input_Colors'] = incorrect_df['top_color'].str.title() + '/' + incorrect_df['bottom_color'].str.title() + '/' + incorrect_df['outerwear_color'].str.title() + '/' + incorrect_df['footwear_color'].str.title()

    hardest_cases = incorrect_df.sort_values(by='confidence', ascending=False).head(20)
    hardest_cases_export = hardest_cases[[
        'Input_Colors', 'actual_color', 'predicted_color', 'Actual_Rank', 'confidence'
    ]].copy()
    hardest_cases_export.columns = ['Input_Colors', 'Actual_Color', 'Predicted_Color', 'Actual_Rank', 'Confidence']
    hardest_cases_export['Actual_Color'] = hardest_cases_export['Actual_Color'].str.title()
    hardest_cases_export['Predicted_Color'] = hardest_cases_export['Predicted_Color'].str.title()

    hardest_cases_export.to_csv('hardest_cases.csv', index=False)
    print("✅ Saved hardest_cases.csv")

    # 11. Generate Jupyter notebook (error_analysis.ipynb)
    notebook = {
     "cells": [
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "# Twelve70 styling prediction model error analysis\n",
        "\n",
        "This notebook provides confusion matrix heatmaps, confidence vs. empirical accuracy plots, and detailed error mode distributions.\n",
        "All numbers are computed from real model predictions on the held-out test split."
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "import pandas as pd\n",
        "import numpy as np\n",
        "import matplotlib.pyplot as plt\n",
        "import seaborn as sns\n",
        "import json\n",
        "\n",
        "%matplotlib inline\n",
        "plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')"
       ]
      },
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "## 1. Validation Report Metrics"
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "with open('error_analysis_report.json') as f:\n",
        "    report = json.load(f)\n",
        "\n",
        "print(\"=== Error Analysis Summary ===\")\n",
        "print(f\"Total Test Predictions : {report['total_predictions']}\")\n",
        "print(f\"Correct Predictions    : {report['correct']}\")\n",
        "print(f\"Incorrect Predictions  : {report['incorrect']}\")\n",
        "print(f\"Empirical Top-1 Accuracy: {report['accuracy']:.2%}\")\n",
        "print(f\"Confidence Calibration : {report['confidence_analysis']['confidence_calibration']}\")"
       ]
      },
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "## 2. Top Confusion Pairs"
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "conf_pairs_df = pd.DataFrame(report['top_confusion_pairs'])\n",
        "print(conf_pairs_df)"
       ]
      },
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "## 3. Confusion Matrix Heatmap (Top 15 Most Confused Colors)"
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "cm = pd.read_csv('confusion_matrix.csv', index_col=0)\n",
        "# Exclude diagonal to focus strictly on mistakes\n",
        "cm_errs = cm.copy()\n",
        "for col in cm_errs.columns:\n",
        "    if col in cm_errs.index:\n",
        "        cm_errs.loc[col, col] = 0\n",
        "\n",
        "top_err_colors = cm_errs.sum(axis=1).sort_values(ascending=False).head(15).index\n",
        "filtered_cm = cm.loc[top_err_colors, top_err_colors]\n",
        "\n",
        "plt.figure(figsize=(12, 10))\n",
        "sns.heatmap(filtered_cm, annot=True, fmt='d', cmap='Oranges', cbar=True)\n",
        "plt.title('Confusion Matrix Heatmap (Top 15 Colors by Misclassifications)')\n",
        "plt.xlabel('Predicted Color')\n",
        "plt.ylabel('Actual Color')\n",
        "plt.tight_layout()\n",
        "plt.savefig('confusion_matrix_heatmap.png', dpi=300)\n",
        "plt.show()"
       ]
      },
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "## 4. Confidence vs. Empirical Accuracy Calibration"
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "cal_bins = report['confidence_analysis']['calibration_bins']\n",
        "bin_labels = [b['bin'] for b in cal_bins]\n",
        "cal_accuracies = [b['empirical_accuracy'] if b['empirical_accuracy'] is not None else 0.0 for b in cal_bins]\n",
        "counts = [b['count'] for b in cal_bins]\n",
        "\n",
        "plt.figure(figsize=(8, 6))\n",
        "bars = plt.bar(bin_labels, cal_accuracies, color='lightcoral', edgecolor='black', alpha=0.8)\n",
        "for bar, n in zip(bars, counts):\n",
        "    plt.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02, f'n={n}', ha='center', fontsize=9)\n",
        "plt.plot([-0.5, 4.5], [0.1, 0.9], color='darkred', linestyle='--', label='Theoretical Ideal Calibration')\n",
        "plt.title('Confidence Calibration Curve (Real Test Predictions)')\n",
        "plt.xlabel('Prediction Confidence Range')\n",
        "plt.ylabel('Empirical Accuracy')\n",
        "plt.ylim(0, 1.05)\n",
        "plt.legend()\n",
        "plt.tight_layout()\n",
        "plt.savefig('confidence_vs_accuracy.png', dpi=300)\n",
        "plt.show()"
       ]
      },
      {
       "cell_type": "markdown",
       "metadata": {},
       "source": [
        "## 5. Error Distribution Across Outfit Categories"
       ]
      },
      {
       "cell_type": "code",
       "execution_count": None,
       "metadata": {},
       "outputs": [],
       "source": [
        "categories = ['Monochromatic Outfits', 'Contrast Outfits', 'Rare Color Combos']\n",
        "accuracies = [\n",
        "    report['error_patterns']['monochromatic_outfits']['accuracy'] or 0.0,\n",
        "    report['error_patterns']['contrast_outfits']['accuracy'] or 0.0,\n",
        "    report['error_patterns']['rare_color_combinations']['accuracy'] or 0.0\n",
        "]\n",
        "\n",
        "plt.figure(figsize=(8, 5))\n",
        "plt.barh(categories, accuracies, color=['seagreen', 'steelblue', 'indianred'], edgecolor='black', height=0.6)\n",
        "plt.axvline(x=report['accuracy'], color='black', linestyle=':', label=f\"Global Mean Accuracy ({report['accuracy']:.1%})\")\n",
        "plt.title('Model Accuracy across Outfit Categories')\n",
        "plt.xlabel('Accuracy')\n",
        "plt.xlim(0, 1.0)\n",
        "plt.legend()\n",
        "plt.tight_layout()\n",
        "plt.savefig('error_by_outfit_category.png', dpi=300)\n",
        "plt.show()"
       ]
      }
     ],
     "metadata": {
      "kernelspec": {
       "display_name": "Python 3",
       "language": "python",
       "name": "python3"
      },
      "language_info": {
       "name": "python"
      }
     },
     "nbformat": 4,
     "nbformat_minor": 2
    }

    with open('error_analysis.ipynb', 'w') as f:
        json.dump(notebook, f, indent=2)
    print("✅ Saved error_analysis.ipynb")
    print("🎉 Deep Error Analysis completed successfully!")

if __name__ == "__main__":
    main()
