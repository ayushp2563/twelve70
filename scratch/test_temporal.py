import os
import sys
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.preprocessing import LabelEncoder

sys.path.append('ml_pipeline')
import train_baseline

def test():
    families_map = train_baseline.load_json_mapping('color_families.json')
    lightness_map = train_baseline.load_json_mapping('color_lightness.json')
    
    df_raw = pd.read_csv('cleaned_predictions.csv')
    df_raw['target_color'] = df_raw['top_outer_color'].where(df_raw['top_outer_color'] != '-', df_raw['predicted_top_outer_color'])
    df_raw['target_color'] = df_raw['target_color'].astype(str).str.strip().str.lower()
    
    for col in train_baseline.INPUT_COLS:
        df_raw[col] = df_raw[col].astype(str).str.strip().str.lower()
        
    class_counts = df_raw['target_color'].value_counts()
    frequent_classes = class_counts[class_counts >= 10].index
    df_filtered = df_raw[df_raw['target_color'].isin(frequent_classes)].copy().reset_index(drop=True)
    
    le = LabelEncoder()
    df_filtered['target_encoded'] = le.fit_transform(df_filtered['target_color'])
    
    df_filtered['year'] = pd.to_datetime(df_filtered['created_at'], errors='coerce').dt.year
    df_temp_train = df_filtered[df_filtered['year'] < 2024].copy().reset_index(drop=True)
    df_temp_test = df_filtered[df_filtered['year'] >= 2024].copy().reset_index(drop=True)
    
    print(f"Total train size: {len(df_temp_train)}, test size: {len(df_temp_test)}")
    
    lgb_params = {
        'objective': 'multiclass',
        'num_class': len(le.classes_),
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
    
    # Method 1: Combo-based split, fit feature engineer on whole pre-2024
    print("\n--- Method 1: Combo split, Feature Engineer fit on ALL pre-2024 ---")
    df_temp_train['combo_id'] = df_temp_train[train_baseline.INPUT_COLS].astype(str).agg('-'.join, axis=1)
    unique_combos = df_temp_train['combo_id'].unique()
    np.random.seed(42)
    np.random.shuffle(unique_combos)
    split_idx = int(len(unique_combos) * 0.8)
    train_combos = set(unique_combos[:split_idx])
    
    df_train_sub = df_temp_train[df_temp_train['combo_id'].isin(train_combos)].copy().reset_index(drop=True)
    df_val_sub = df_temp_train[~df_temp_train['combo_id'].isin(train_combos)].copy().reset_index(drop=True)
    
    engineer_1 = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer_1.fit(df_temp_train) # Fit on all pre-2024
    
    X_train_1 = engineer_1.transform(df_train_sub)
    X_val_1 = engineer_1.transform(df_val_sub)
    X_test_1 = engineer_1.transform(df_temp_test)
    
    model_1 = lgb.train(
        lgb_params,
        lgb.Dataset(X_train_1, label=df_train_sub['target_encoded']),
        num_boost_round=150,
        valid_sets=[lgb.Dataset(X_val_1, label=df_val_sub['target_encoded'])],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    val_acc_1 = (np.argmax(model_1.predict(X_val_1), axis=1) == df_val_sub['target_encoded']).mean()
    test_acc_1 = (np.argmax(model_1.predict(X_test_1), axis=1) == df_temp_test['target_encoded']).mean()
    print(f"Val Acc: {val_acc_1:.4%}, Test Acc: {test_acc_1:.4%}, Drop: {val_acc_1 - test_acc_1:.4%}")

    # Method 2: Random split, fit feature engineer on train sub-split, but early stopping on val
    print("\n--- Method 2: Random split, Feature Engineer fit on train sub-split ---")
    from sklearn.model_selection import train_test_split
    df_train_sub_2, df_val_sub_2 = train_test_split(df_temp_train, test_size=0.20, random_state=42)
    
    engineer_2 = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer_2.fit(df_train_sub_2)
    
    X_train_2 = engineer_2.transform(df_train_sub_2)
    X_val_2 = engineer_2.transform(df_val_sub_2)
    X_test_2 = engineer_2.transform(df_temp_test)
    
    model_2 = lgb.train(
        lgb_params,
        lgb.Dataset(X_train_2, label=df_train_sub_2['target_encoded']),
        num_boost_round=150,
        valid_sets=[lgb.Dataset(X_val_2, label=df_val_sub_2['target_encoded'])],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    val_acc_2 = (np.argmax(model_2.predict(X_val_2), axis=1) == df_val_sub_2['target_encoded']).mean()
    test_acc_2 = (np.argmax(model_2.predict(X_test_2), axis=1) == df_temp_test['target_encoded']).mean()
    print(f"Val Acc: {val_acc_2:.4%}, Test Acc: {test_acc_2:.4%}, Drop: {val_acc_2 - test_acc_2:.4%}")

    # Method 3: Random split, Feature Engineer fit on ALL pre-2024
    print("\n--- Method 3: Random split, Feature Engineer fit on ALL pre-2024 ---")
    df_train_sub_3, df_val_sub_3 = train_test_split(df_temp_train, test_size=0.20, random_state=42)
    
    engineer_3 = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer_3.fit(df_temp_train)
    
    X_train_3 = engineer_3.transform(df_train_sub_3)
    X_val_3 = engineer_3.transform(df_val_sub_3)
    X_test_3 = engineer_3.transform(df_temp_test)
    
    model_3 = lgb.train(
        lgb_params,
        lgb.Dataset(X_train_3, label=df_train_sub_3['target_encoded']),
        num_boost_round=150,
        valid_sets=[lgb.Dataset(X_val_3, label=df_val_sub_3['target_encoded'])],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    val_acc_3 = (np.argmax(model_3.predict(X_val_3), axis=1) == df_val_sub_3['target_encoded']).mean()
    test_acc_3 = (np.argmax(model_3.predict(X_test_3), axis=1) == df_temp_test['target_encoded']).mean()
    print(f"Val Acc: {val_acc_3:.4%}, Test Acc: {test_acc_3:.4%}, Drop: {val_acc_3 - test_acc_3:.4%}")

if __name__ == '__main__':
    test()
