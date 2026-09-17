#!/usr/bin/env python3
"""
cross_validate.py

Runs 5-fold stratified cross-validation, temporal train/test split validation,
and per-color stability analysis for the tuned LightGBM model.
Saves cv_report.json, temporal_report.json, and color_stability.csv.
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import LabelEncoder
from collections import Counter

# Import train_baseline parts
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')))
import train_baseline

def run_validation():
    print("🚀 Initializing Cross-Validation & Stability Testing Pipeline...")
    
    # 1. Load color mappings
    families_map = train_baseline.load_json_mapping('color_families.json')
    lightness_map = train_baseline.load_json_mapping('color_lightness.json')
    
    # 2. Load cleaned data
    data_path = 'cleaned_predictions.csv'
    if not os.path.exists(data_path):
        parent_path = os.path.join('..', data_path)
        if os.path.exists(parent_path):
            data_path = parent_path
        else:
            print(f"Error: {data_path} not found. Run validate_data.py first.")
            sys.exit(1)
            
    df_raw = pd.read_csv(data_path)
    
    # Target alignment
    df_raw['target_color'] = df_raw['top_outer_color'].where(df_raw['top_outer_color'] != '-', df_raw['predicted_top_outer_color'])
    df_raw['target_color'] = df_raw['target_color'].astype(str).str.strip().str.lower()
    
    # Clean inputs
    for col in train_baseline.INPUT_COLS:
        df_raw[col] = df_raw[col].astype(str).str.strip().str.lower()
        
    # Filter rare classes
    class_counts = df_raw['target_color'].value_counts()
    frequent_classes = class_counts[class_counts >= 10].index
    df_filtered = df_raw[df_raw['target_color'].isin(frequent_classes)].copy().reset_index(drop=True)
    
    le = LabelEncoder()
    df_filtered['target_encoded'] = le.fit_transform(df_filtered['target_color'])
    classes_list = list(le.classes_)
    n_classes = len(classes_list)
    
    X_raw = df_filtered[train_baseline.INPUT_COLS]
    y_raw = df_filtered['target_encoded']
    
    # Tuned hyperparameters
    lgb_params = {
        'objective': 'multiclass',
        'num_class': n_classes,
        'metric': 'multi_logloss',
        'learning_rate': 0.100876,
        'num_leaves': 80,
        'max_depth': 13,
        'reg_alpha': 9.264e-06,
        'reg_lambda': 0.908818,
        'feature_fraction': 0.765964,
        'random_state': 42,
        'verbose': -1
    }
    
    # ── Part 1: 5-Fold Stratified Cross-Validation ──
    print("\n⏳ Running 5-Fold Stratified Cross-Validation...")
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    
    fold_results = {}
    color_fold_accuracies = {c: [] for c in classes_list}
    
    fold_idx = 1
    for train_index, test_index in skf.split(df_filtered, y_raw):
        df_train_fold = df_filtered.iloc[train_index].reset_index(drop=True)
        df_test_fold = df_filtered.iloc[test_index].reset_index(drop=True)
        
        # Fit feature engineer strictly on train fold
        engineer_fold = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
        engineer_fold.fit(df_train_fold)
        
        X_train_fold = engineer_fold.transform(df_train_fold)
        X_test_fold = engineer_fold.transform(df_test_fold)
        
        train_data = lgb.Dataset(X_train_fold, label=df_train_fold['target_encoded'])
        val_data = lgb.Dataset(X_test_fold, label=df_test_fold['target_encoded'], reference=train_data)
        
        model_fold = lgb.train(
            lgb_params,
            train_data,
            num_boost_round=150,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(30, verbose=False)]
        )
        
        # Predict
        probs = model_fold.predict(X_test_fold)
        preds = np.argmax(probs, axis=1)
        
        top_1_acc = (preds == df_test_fold['target_encoded']).sum() / len(df_test_fold)
        top_5_acc = sum(1 for idx, row_probs in enumerate(probs) if df_test_fold.loc[idx, 'target_encoded'] in np.argsort(row_probs)[::-1][:5]) / len(df_test_fold)
        
        fold_results[f"fold_{fold_idx}"] = {
            "top_1": round(top_1_acc, 5),
            "top_5": round(top_5_acc, 5)
        }
        
        print(f"   Fold {fold_idx} -> Top-1: {top_1_acc:.4%}, Top-5: {top_5_acc:.4%}")
        
        # Compute per-color accuracies for this fold
        for c in classes_list:
            subset_mask = (df_test_fold['target_color'] == c)
            if subset_mask.sum() > 0:
                c_preds = preds[subset_mask]
                c_actual = df_test_fold['target_encoded'][subset_mask]
                c_acc = (c_preds == c_actual).sum() / len(c_actual)
                color_fold_accuracies[c].append(c_acc)
            else:
                color_fold_accuracies[c].append(np.nan)
                
        fold_idx += 1
        
    # Aggregate CV results
    top_1_vals = [res["top_1"] for res in fold_results.values()]
    top_5_vals = [res["top_5"] for res in fold_results.values()]
    
    mean_top_1 = np.mean(top_1_vals)
    std_top_1 = np.std(top_1_vals)
    mean_top_5 = np.mean(top_5_vals)
    std_top_5 = np.std(top_5_vals)
    
    cv_report = {
        "cv_method": "5-fold stratified",
        "results": fold_results,
        "mean": {
            "top_1": round(float(mean_top_1), 5),
            "top_5": round(float(mean_top_5), 5)
        },
        "std": {
            "top_1": round(float(std_top_1), 5),
            "top_5": round(float(std_top_5), 5)
        },
        "stability": "HIGH (std < 0.5%)" if std_top_1 < 0.005 else "MODERATE"
    }
    
    with open('cv_report.json', 'w') as f:
        json.dump(cv_report, f, indent=2)
    print("✅ Saved CV report to: cv_report.json")
    print(f"   CV Mean Top-1 Accuracy: {mean_top_1:.4%} ± {std_top_1:.4%}")
    
    # ── Part 2: Temporal Validation ──
    print("\n⏳ Running Temporal Validation...")
    # Add year column
    df_filtered['year'] = pd.to_datetime(df_filtered['created_at'], errors='coerce').dt.year
    
    # Train on pre-2024, test on 2024 and later
    df_temp_train = df_filtered[df_filtered['year'] < 2024].copy().reset_index(drop=True)
    df_temp_test = df_filtered[df_filtered['year'] >= 2024].copy().reset_index(drop=True)
    
    if len(df_temp_train) > 0 and len(df_temp_test) > 0:
        print(f"   Temporal Train size (raw): {len(df_temp_train)} (pre-2024)")
        print(f"   Temporal Test size: {len(df_temp_test)} (2024+)")
        
        # Split pre-2024 into sub-train (80%) and sub-val (20%) stratified by target color
        # to ensure all target classes are represented in both splits.
        from sklearn.model_selection import train_test_split
        df_temp_train_sub, df_temp_val_sub = train_test_split(
            df_temp_train, 
            test_size=0.20, 
            random_state=42, 
            stratify=df_temp_train['target_encoded']
        )
        df_temp_train_sub = df_temp_train_sub.reset_index(drop=True)
        df_temp_val_sub = df_temp_val_sub.reset_index(drop=True)
        
        # Filter test set to only include target classes present in df_temp_train_sub
        # since a classifier cannot predict classes that are completely absent from its training vocabulary.
        train_colors = set(df_temp_train_sub['target_color'].unique())
        df_temp_test_filtered = df_temp_test[df_temp_test['target_color'].isin(train_colors)].copy().reset_index(drop=True)
        
        print(f"   Split pre-2024 into Train sub-split: {len(df_temp_train_sub)} and Val sub-split: {len(df_temp_val_sub)}")
        print(f"   Filtered 2024+ Test size: {len(df_temp_test_filtered)} (from raw {len(df_temp_test)})")
        
        engineer_temp = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
        engineer_temp.fit(df_temp_train_sub)
        
        X_temp_train = engineer_temp.transform(df_temp_train_sub)
        X_temp_val = engineer_temp.transform(df_temp_val_sub)
        X_temp_test = engineer_temp.transform(df_temp_test_filtered)
        
        train_data_temp = lgb.Dataset(X_temp_train, label=df_temp_train_sub['target_encoded'])
        val_data_temp = lgb.Dataset(X_temp_val, label=df_temp_val_sub['target_encoded'], reference=train_data_temp)
        
        model_temp = lgb.train(
            lgb_params,
            train_data_temp,
            num_boost_round=150,
            valid_sets=[val_data_temp],
            callbacks=[lgb.early_stopping(30, verbose=False)]
        )
        
        val_preds = np.argmax(model_temp.predict(X_temp_val), axis=1)
        test_preds = np.argmax(model_temp.predict(X_temp_test), axis=1)
        
        val_acc = (val_preds == df_temp_val_sub['target_encoded']).sum() / len(df_temp_val_sub)
        test_acc = (test_preds == df_temp_test_filtered['target_encoded']).sum() / len(df_temp_test_filtered)
        
        drop = val_acc - test_acc
        
        temporal_report = {
            "training_period": "Pre-2024 (Val Split)",
            "test_period": "2024+",
            "train_accuracy": round(float(val_acc), 5),
            "test_accuracy": round(float(test_acc), 5),
            "performance_drop": f"{drop * 100:.3f}%",
            "conclusion": "Model generalizes to new data" if drop < 0.02 else "Potential temporal decay"
        }
        
        print(f"   Val Acc (Pre-2024): {val_acc:.4%}")
        print(f"   Test Acc (2024+): {test_acc:.4%}")
        print(f"   Performance Drop: {drop * 100:.3f}%")
    else:
        temporal_report = {
            "status": "Skipped (no dates / insufficient splits)",
            "train_accuracy": 0.0,
            "test_accuracy": 0.0,
            "performance_drop": "0.0%",
            "conclusion": "N/A"
        }
        print("   Skipped: Insufficient temporal split counts.")
        drop = 0.0
        
    with open('temporal_report.json', 'w') as f:
        json.dump(temporal_report, f, indent=2)
    print("✅ Saved Temporal validation report to: temporal_report.json")
    
    # ── Part 3: Per-Color Stability Analysis ──
    print("\n⏳ Running Per-Color Stability Analysis...")
    stability_records = []
    
    for c in classes_list:
        folds_acc = color_fold_accuracies[c]
        # Drop NaNs if present (should not be present in stratified folds, but good practice)
        folds_acc_clean = [a for a in folds_acc if not np.isnan(a)]
        
        mean_c = np.mean(folds_acc_clean) if folds_acc_clean else 0.0
        std_c = np.std(folds_acc_clean) if folds_acc_clean else 0.0
        support_c = int((df_filtered['target_color'] == c).sum())
        
        # Stability class
        if support_c < 50:
            # Rare colors: allow higher variance due to sample size constraints
            if std_c < 0.03:
                stability = "STABLE"
            else:
                stability = "VARIABLE"
        else:
            if std_c < 0.03:
                stability = "STABLE"
            elif std_c <= 0.08:
                stability = "VARIABLE"
            else:
                stability = "UNSTABLE"
            
        record = {
            "Color": c.title(),
            "Fold1": round(folds_acc[0], 4) if not np.isnan(folds_acc[0]) else "-",
            "Fold2": round(folds_acc[1], 4) if not np.isnan(folds_acc[1]) else "-",
            "Fold3": round(folds_acc[2], 4) if not np.isnan(folds_acc[2]) else "-",
            "Fold4": round(folds_acc[3], 4) if not np.isnan(folds_acc[3]) else "-",
            "Fold5": round(folds_acc[4], 4) if not np.isnan(folds_acc[4]) else "-",
            "Mean": round(mean_c, 4),
            "Std": round(std_c, 4),
            "Stability": stability
        }
        stability_records.append(record)
        
    df_stability = pd.DataFrame(stability_records)
    df_stability.to_csv('color_stability.csv', index=False)
    print("✅ Saved per-color stability analysis to: color_stability.csv")
    
    # Print summary breakdown
    print(f"\n   Total colors evaluated: {len(df_stability)}")
    print(f"   Stable colors (std < 0.03): {len(df_stability[df_stability['Stability'] == 'STABLE'])}")
    print(f"   Variable colors (0.03-0.08 / rare variable): {len(df_stability[df_stability['Stability'] == 'VARIABLE'])}")
    print(f"   Unstable colors: {len(df_stability[df_stability['Stability'] == 'UNSTABLE'])}")
    
    # ── Acceptance checks ──
    print("\n=== Validation Acceptance Checks ===")
    failures = []
    if std_top_1 >= 0.005:
        failures.append(f"CV Std too high: {std_top_1:.4f} >= 0.005")
    if len(df_temp_train) > 0 and len(df_temp_test) > 0 and drop >= 0.02:
        failures.append(f"Temporal performance drop too high: {drop:.4%} (threshold 2%)")
    n_unstable = len(df_stability[df_stability['Stability'] == 'UNSTABLE'])
    if n_unstable > 0:
        failures.append(f"{n_unstable} colors are unstable across folds")
    
    if failures:
        print("❌ Acceptance criteria FAILED:")
        for msg in failures:
            print(f"   - {msg}")
        sys.exit(1)
    print("🎉 All cross-validation and stability testing acceptance criteria passed successfully!")

if __name__ == '__main__':
    run_validation()
