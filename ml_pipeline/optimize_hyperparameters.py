#!/usr/bin/env python3
"""
optimize_hyperparameters.py

Performs Bayesian optimization (using Optuna) to find the best hyperparameters
for the LightGBM classifier.
Saves the optimized model to tuned_model.pkl, outputs optimization_report.json,
and plots learning curves to learning_curves.png.
"""

import os
os.environ['MPLCONFIGDIR'] = os.path.abspath('matplotlib_config')
import sys
import json
import pickle
import numpy as np
import pandas as pd
import lightgbm as lgb
import optuna
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from collections import Counter

# Import train_baseline parts
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')))
import train_baseline

def run_optimization():
    print("🚀 Initializing Hyperparameter Optimization Pipeline...")
    
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
    
    # Splits (70 / 15 / 15)
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
    
    # Fit Feature Engineer
    engineer = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer.fit(df_train)
    
    # Transform
    X_train = engineer.transform(df_train)
    X_val = engineer.transform(df_val)
    X_test = engineer.transform(df_test)
    
    # Set up datasets
    train_dataset = lgb.Dataset(X_train, label=df_train['target_encoded'])
    val_dataset = lgb.Dataset(X_val, label=df_val['target_encoded'], reference=train_dataset)
    
    # Make Optuna quiet
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    
    def objective(trial):
        # Suggest parameters from search space
        lr = trial.suggest_float('learning_rate', 0.005, 0.3, log=True)
        num_leaves = trial.suggest_int('num_leaves', 20, 100)
        max_depth = trial.suggest_int('max_depth', 3, 15)
        reg_alpha = trial.suggest_float('reg_alpha', 1e-8, 10.0, log=True)
        reg_lambda = trial.suggest_float('reg_lambda', 1e-8, 10.0, log=True)
        feature_fraction = trial.suggest_float('feature_fraction', 0.5, 1.0)
        
        params = {
            'objective': 'multiclass',
            'num_class': n_classes,
            'metric': 'multi_logloss',
            'learning_rate': lr,
            'num_leaves': num_leaves,
            'max_depth': max_depth,
            'reg_alpha': reg_alpha,
            'reg_lambda': reg_lambda,
            'feature_fraction': feature_fraction,
            'random_state': 42,
            'verbose': -1
        }
        
        # Train model with early stopping
        model = lgb.train(
            params,
            train_dataset,
            num_boost_round=150,
            valid_sets=[val_dataset],
            callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=False)]
        )
        
        # Calculate Validation Top-1 accuracy
        val_probs = model.predict(X_val)
        val_preds = np.argmax(val_probs, axis=1)
        val_acc = (val_preds == df_val['target_encoded']).sum() / len(df_val)
        
        return val_acc
        
    print("⏳ Running 50 Bayesian optimization trials using Optuna...")
    study = optuna.create_study(direction='maximize')
    study.optimize(objective, n_trials=50, show_progress_bar=True)
    
    best_trial = study.best_trial
    print(f"\n🎉 Best trial found: Trial #{best_trial.number}")
    print(f"   Validation Accuracy: {best_trial.value:.4%}")
    print("   Hyperparameters:")
    for k, v in best_trial.params.items():
        print(f"     - {k}: {v}")
        
    # 3. Train the final optimized model on Train + Val splits using best parameters
    # Let's track logloss at each iteration to generate learning curves
    best_params = {
        'objective': 'multiclass',
        'num_class': n_classes,
        'metric': 'multi_logloss',
        'random_state': 42,
        'verbose': -1,
        **best_trial.params
    }
    
    evals_result = {}
    
    # Re-train with eval tracking
    train_data_final = lgb.Dataset(X_train, label=df_train['target_encoded'])
    val_data_final = lgb.Dataset(X_val, label=df_val['target_encoded'], reference=train_data_final)
    
    print("\n⏳ Re-training final model with best hyperparameters...")
    best_model = lgb.train(
        best_params,
        train_data_final,
        num_boost_round=200,
        valid_sets=[train_data_final, val_data_final],
        callbacks=[
            lgb.early_stopping(30, verbose=False),
            lgb.record_evaluation(evals_result)
        ]
    )
    
    # 4. Evaluate on Test Split
    print("Evaluating optimized model on Test Split...")
    test_probs = best_model.predict(X_test)
    test_preds = np.argmax(test_probs, axis=1)
    
    test_top_1_acc = (test_preds == df_test['target_encoded']).sum() / len(df_test)
    test_top_5_acc = sum(1 for idx, row_probs in enumerate(test_probs) if df_test.loc[idx, 'target_encoded'] in np.argsort(row_probs)[::-1][:5]) / len(df_test)
    test_top_10_acc = sum(1 for idx, row_probs in enumerate(test_probs) if df_test.loc[idx, 'target_encoded'] in np.argsort(row_probs)[::-1][:10]) / len(df_test)
    
    print("\n=== Optimized Model Performance ===")
    print(f"Top-1 Accuracy  : {test_top_1_acc:.4%}")
    print(f"Top-5 Accuracy  : {test_top_5_acc:.4%}")
    print(f"Top-10 Accuracy : {test_top_10_acc:.4%}")
    
    # 5. Save serialized deployment package
    tuned_model_path = 'tuned_model.pkl'
    deployment_package = {
        'model': best_model,
        'label_encoder': le,
        'feature_engineer': engineer,
        'classes': classes_list,
        'hyperparameters': best_trial.params
    }
    with open(tuned_model_path, 'wb') as f:
        pickle.dump(deployment_package, f)
    print(f"✅ Serialized tuned model package saved to: {tuned_model_path}")
    
    # 6. Save optimization_report.json
    all_trials_records = []
    for t in study.trials:
        all_trials_records.append({
            "trial_number": t.number,
            "status": str(t.state),
            "val_accuracy": float(t.value) if t.value is not None else 0.0,
            "params": t.params
        })
        
    optimization_report = {
        "best_trial_number": best_trial.number,
        "best_validation_accuracy": float(best_trial.value),
        "best_hyperparameters": best_trial.params,
        "test_metrics": {
            "top_1_accuracy": float(test_top_1_acc),
            "top_5_accuracy": float(test_top_5_acc),
            "top_10_accuracy": float(test_top_10_acc)
        },
        "all_trial_results": all_trials_records
    }
    
    with open('optimization_report.json', 'w') as f:
        json.dump(optimization_report, f, indent=2)
    print("✅ Optimization report saved to: optimization_report.json")
    
    # 7. Generate Learning Curves (training progress) plot
    print("⏳ Plotting learning curves...")
    train_loss = evals_result['training']['multi_logloss']
    val_loss = evals_result['valid_1']['multi_logloss']
    
    plt.figure(figsize=(10, 6))
    plt.plot(train_loss, label='Train Multi-Logloss', color='#2b6cb0', linewidth=2)
    plt.plot(val_loss, label='Validation Multi-Logloss', color='#e53e3e', linewidth=2)
    plt.axvline(np.argmin(val_loss), color='#319795', linestyle='--', label=f'Best Iteration ({np.argmin(val_loss)})')
    plt.title('LightGBM Multiclass Model — Training Progress (Learning Curves)', fontsize=14, fontweight='bold', pad=15)
    plt.xlabel('Boosting Rounds', fontsize=12)
    plt.ylabel('Multi-Logloss', fontsize=12)
    plt.grid(True, linestyle=':', alpha=0.6)
    plt.legend(fontsize=11)
    
    # Apply premium aesthetics
    ax = plt.gca()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plot_path = 'learning_curves.png'
    plt.savefig(plot_path, dpi=300)
    plt.close()
    print(f"✅ Learning curves plot saved to: {plot_path}")
    
    print("\n=== Validation Check ===")
    assert test_top_1_acc >= 0.45, "Error: Did not meet the target 45% Top-1 accuracy!"
    print("🎉 All acceptance criteria successfully met!")

if __name__ == '__main__':
    run_optimization()
