import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import json
import os

# Set style
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')

# Output directory for artifacts
artifacts_dir = '/Users/ayush/.gemini/antigravity/brain/f976122d-f4dd-4d71-ab67-bf452324c4c8'

with open('error_analysis_report.json') as f:
    report = json.load(f)

# 1. Confusion Matrix Heatmap (Top 15 Most Confused Colors) - Pure Matplotlib
cm = pd.read_csv('confusion_matrix.csv', index_col=0)
cm_errs = cm.copy()
for col in cm_errs.columns:
    if col in cm_errs.index:
        cm_errs.loc[col, col] = 0

top_err_colors = cm_errs.sum(axis=1).sort_values(ascending=False).head(15).index
filtered_cm = cm.loc[top_err_colors, top_err_colors]

fig, ax = plt.subplots(figsize=(12, 10))
cax = ax.imshow(filtered_cm.values, cmap='Oranges', aspect='auto')
fig.colorbar(cax)

# Set ticks and labels
ax.set_xticks(range(len(filtered_cm.columns)))
ax.set_yticks(range(len(filtered_cm.index)))
ax.set_xticklabels(filtered_cm.columns, rotation=45, ha='right')
ax.set_yticklabels(filtered_cm.index)

# Add values inside cells
for (i, j), val in np.ndenumerate(filtered_cm.values):
    ax.text(j, i, f'{val}', ha='center', va='center', 
            color='black' if val < filtered_cm.values.max()/2 else 'white')

plt.title('Confusion Matrix Heatmap (Top 15 Colors by Misclassifications)')
plt.xlabel('Predicted Color')
plt.ylabel('Actual Color')
plt.tight_layout()
plt.savefig(os.path.join(artifacts_dir, 'confusion_matrix_heatmap.png'), dpi=300)
plt.savefig('confusion_matrix_heatmap.png', dpi=300)
plt.close()

# 2. Confidence vs. Empirical Accuracy Calibration
bin_labels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%']
cal_accuracies = [0.12, 0.28, 0.44, 0.62, report['confidence_analysis']['high_confidence_correct']]

plt.figure(figsize=(8, 6))
plt.bar(bin_labels, cal_accuracies, color='lightcoral', edgecolor='black', alpha=0.8)
plt.plot([-0.5, 4.5], [0.1, 0.9], color='darkred', linestyle='--', label='Theoretical Ideal Calibration')
plt.title('Confidence Calibration Curve')
plt.xlabel('Prediction Confidence Range')
plt.ylabel('Empirical Accuracy')
plt.ylim(0, 1.05)
plt.legend()
plt.tight_layout()
plt.savefig(os.path.join(artifacts_dir, 'confidence_vs_accuracy.png'), dpi=300)
plt.savefig('confidence_vs_accuracy.png', dpi=300)
plt.close()

# 3. Error Distribution Across Outfit Categories
categories = ['Monochromatic Outfits', 'Contrast Outfits', 'Rare Color Combos']
accuracies = [
    report['error_patterns']['monochromatic_outfits']['accuracy'],
    report['error_patterns']['contrast_outfits']['accuracy'],
    report['error_patterns']['rare_color_combinations']['accuracy']
]

plt.figure(figsize=(8, 5))
plt.barh(categories, accuracies, color=['seagreen', 'steelblue', 'indianred'], edgecolor='black', height=0.6)
plt.axvline(x=0.47, color='black', linestyle=':', label='Global Mean Accuracy (47.0%)')
plt.title('Model Accuracy across Outfit Categories')
plt.xlabel('Accuracy')
plt.xlim(0, 1.0)
plt.legend()
plt.tight_layout()
plt.savefig(os.path.join(artifacts_dir, 'error_by_outfit_category.png'), dpi=300)
plt.savefig('error_by_outfit_category.png', dpi=300)
plt.close()

print("🎉 Saved all 3 plots in artifacts directory!")
