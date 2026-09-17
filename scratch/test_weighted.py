# scratch/test_weighted.py
import os
import sys
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from collections import Counter

sys.path.append('.')
import train_baseline

# 1. Load color mappings
families_map = train_baseline.load_json_mapping('color_families.json')
lightness_map = train_baseline.load_json_mapping('color_lightness.json')

# 2. Load cleaned data
df_raw = pd.read_csv('cleaned_predictions.csv')
df_raw['target_color'] = df_raw['top_outer_color'].where(df_raw['top_outer_color'] != '-', df_raw['predicted_top_outer_color'])
df_raw['target_color'] = df_raw['target_color'].astype(str).str.strip().str.lower()

# Filter out rare classes (counts < 10)
class_counts = df_raw['target_color'].value_counts()
frequent_classes = class_counts[class_counts >= 10].index
df_filtered = df_raw[df_raw['target_color'].isin(frequent_classes)].copy().reset_index(drop=True)

le = LabelEncoder()
df_filtered['target_encoded'] = le.fit_transform(df_filtered['target_color'])
classes_list = list(le.classes_)
n_classes = len(classes_list)

# Split
y = df_filtered['target_encoded']
X_indices = pd.Series(df_filtered.index)
train_idx, temp_idx, y_train, y_temp = train_test_split(
    X_indices, y, test_size=0.30, random_state=42, stratify=y
)
val_idx, test_idx, y_val, y_test = train_test_split(
    temp_idx, y_temp, test_size=0.50, random_state=42, stratify=y_temp
)

df_train = df_filtered.loc[train_idx].copy().reset_index(drop=True)
df_val = df_filtered.loc[val_idx].copy().reset_index(drop=True)
df_test = df_filtered.loc[test_idx].copy().reset_index(drop=True)

# Feature Engineer
engineer = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
engineer.fit(df_train)

X_train = engineer.transform(df_train)
X_val = engineer.transform(df_val)
X_test = engineer.transform(df_test)

# Calculate class weights
counter = Counter(df_train['target_encoded'])
total = len(df_train)
class_weights = {cls: total / (len(counter) * count) for cls, count in counter.items()}
train_weights = df_train['target_encoded'].map(class_weights)
val_weights = df_val['target_encoded'].map(class_weights)

train_data = lgb.Dataset(X_train, label=df_train['target_encoded'], weight=train_weights)
val_data = lgb.Dataset(X_val, label=df_val['target_encoded'], weight=val_weights, reference=train_data)

params = {
    'objective': 'multiclass',
    'num_class': n_classes,
    'metric': 'multi_logloss',
    'learning_rate': 0.05,
    'num_leaves': 31,
    'max_depth': 6,
    'feature_fraction': 0.8,
    'random_state': 42,
    'verbose': -1
}

model = lgb.train(
    params,
    train_data,
    num_boost_round=300,
    valid_sets=[train_data, val_data],
    callbacks=[lgb.early_stopping(50, verbose=False)]
)

test_probs = model.predict(X_test)
top_1_predictions = np.argmax(test_probs, axis=1)
top_1_acc = (top_1_predictions == df_test['target_encoded']).sum() / len(df_test)
print(f"Top-1 Accuracy (Weighted): {top_1_acc:.4f}")

# Predict Scenarios
scenarios = [
    {
        'name': 'Scenario A: Classic neutral combo',
        'top_color': 'black', 'bottom_color': 'charcoal', 'outerwear_color': 'camel', 'footwear_color': 'black'
    },
    {
        'name': 'Scenario B: Warm tones',
        'top_color': 'rust', 'bottom_color': 'terracotta', 'outerwear_color': 'camel', 'footwear_color': 'brown'
    },
    {
        'name': 'Scenario C: Rare combination',
        'top_color': 'sage', 'bottom_color': 'olive', 'outerwear_color': 'burgundy', 'footwear_color': 'gold'
    }
]

df_scenarios = pd.DataFrame(scenarios)
for col in ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color']:
    df_scenarios[col] = df_scenarios[col].astype(str).str.strip().str.lower()

X_sc = engineer.transform(df_scenarios)
probs_sc = model.predict(X_sc)

for idx, sc in enumerate(scenarios):
    row_probs = probs_sc[idx]
    top_indices = np.argsort(row_probs)[::-1][:3]
    print(sc['name'])
    for rank, i in enumerate(top_indices):
        print(f'  Rank {rank+1}: class={classes_list[i]} (prob={row_probs[i]:.4f})')
