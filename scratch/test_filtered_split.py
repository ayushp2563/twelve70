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
    
    df_train_sub, df_val_sub = train_test_split(
        df_temp_train, 
        test_size=0.20, 
        random_state=42, 
        stratify=df_temp_train['target_encoded']
    )
    df_train_sub = df_train_sub.reset_index(drop=True)
    df_val_sub = df_val_sub.reset_index(drop=True)
    
    # Filter test set to only include target classes present in df_train_sub
    train_colors = set(df_train_sub['target_color'].unique())
    df_temp_test_filtered = df_temp_test[df_temp_test['target_color'].isin(train_colors)].copy().reset_index(drop=True)
    
    print(f"Train size: {len(df_train_sub)}, Val size: {len(df_val_sub)}")
    print(f"Test size (raw): {len(df_temp_test)}, Test size (filtered): {len(df_temp_test_filtered)}")
    
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
    
    engineer = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer.fit(df_train_sub)
    
    X_train = engineer.transform(df_train_sub)
    X_val = engineer.transform(df_val_sub)
    X_test_filtered = engineer.transform(df_temp_test_filtered)
    
    train_data = lgb.Dataset(X_train, label=df_train_sub['target_encoded'])
    val_data = lgb.Dataset(X_val, label=df_val_sub['target_encoded'], reference=train_data)
    
    model = lgb.train(
        lgb_params,
        train_data,
        num_boost_round=150,
        valid_sets=[val_data],
        callbacks=[lgb.early_stopping(30, verbose=False)]
    )
    
    val_preds = np.argmax(model.predict(X_val), axis=1)
    test_preds = np.argmax(model.predict(X_test_filtered), axis=1)
    val_acc = (val_preds == df_val_sub['target_encoded']).mean()
    test_acc_filtered = (test_preds == df_temp_test_filtered['target_encoded']).mean()
    
    print(f"Val Acc: {val_acc:.4%}")
    print(f"Test Acc (filtered): {test_acc_filtered:.4%}, Drop: {val_acc - test_acc_filtered:.4%}")

if __name__ == '__main__':
    main()
