import os
import sys
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import train_test_split

sys.path.append('ml_pipeline')
import train_baseline

def main():
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
    
    n_classes = len(le.classes_)
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
    
    # Configuration 1: Train on full pre-2024, early stop on 2024+
    print("\n--- Config 1: Train on full pre-2024, early stop on 2024+ ---")
    engineer_1 = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer_1.fit(df_temp_train)
    
    X_train_1 = engineer_1.transform(df_temp_train)
    X_test_1 = engineer_1.transform(df_temp_test)
    
    train_data_1 = lgb.Dataset(X_train_1, label=df_temp_train['target_encoded'])
    val_data_1 = lgb.Dataset(X_test_1, label=df_temp_test['target_encoded'], reference=train_data_1)
    
    model_1 = lgb.train(
        lgb_params,
        train_data_1,
        num_boost_round=150,
        valid_sets=[val_data_1],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    train_preds_1 = np.argmax(model_1.predict(X_train_1), axis=1)
    test_preds_1 = np.argmax(model_1.predict(X_test_1), axis=1)
    train_acc_1 = (train_preds_1 == df_temp_train['target_encoded']).mean()
    test_acc_1 = (test_preds_1 == df_temp_test['target_encoded']).mean()
    print(f"Train Acc: {train_acc_1:.4%}, Test Acc: {test_acc_1:.4%}, Drop: {train_acc_1 - test_acc_1:.4%}")

    # Configuration 2: Random split, fit on train sub-split, early stop on val sub-split
    print("\n--- Config 2: Random split, fit on train sub-split, early stop on val sub-split ---")
    df_train_sub, df_val_sub = train_test_split(
        df_temp_train, 
        test_size=0.20, 
        random_state=42, 
        stratify=df_temp_train['target_encoded']
    )
    df_train_sub = df_train_sub.reset_index(drop=True)
    df_val_sub = df_val_sub.reset_index(drop=True)
    
    engineer_2 = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer_2.fit(df_train_sub)
    
    X_train_2 = engineer_2.transform(df_train_sub)
    X_val_2 = engineer_2.transform(df_val_sub)
    X_test_2 = engineer_2.transform(df_temp_test)
    
    train_data_2 = lgb.Dataset(X_train_2, label=df_train_sub['target_encoded'])
    val_data_2 = lgb.Dataset(X_val_2, label=df_val_sub['target_encoded'], reference=train_data_2)
    
    model_2 = lgb.train(
        lgb_params,
        train_data_2,
        num_boost_round=150,
        valid_sets=[val_data_2],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    val_preds_2 = np.argmax(model_2.predict(X_val_2), axis=1)
    test_preds_2 = np.argmax(model_2.predict(X_test_2), axis=1)
    val_acc_2 = (val_preds_2 == df_val_sub['target_encoded']).mean()
    test_acc_2 = (test_preds_2 == df_temp_test['target_encoded']).mean()
    print(f"Val Acc: {val_acc_2:.4%}, Test Acc: {test_acc_2:.4%}, Drop: {val_acc_2 - test_acc_2:.4%}")

if __name__ == '__main__':
    main()
