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
    
    # Filter 2024+ test set to only include target colors that are present in pre-2024 train set
    train_colors = set(df_temp_train['target_color'].unique())
    df_temp_test_filtered = df_temp_test[df_temp_test['target_color'].isin(train_colors)].copy().reset_index(drop=True)
    
    print(f"Train size: {len(df_temp_train)}, Test size (raw): {len(df_temp_test)}, Test size (filtered): {len(df_temp_test_filtered)}")
    
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
    
    # Fit feature engineer on pre-2024 train
    engineer = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer.fit(df_temp_train)
    
    X_train = engineer.transform(df_temp_train)
    X_test_raw = engineer.transform(df_temp_test)
    X_test_filtered = engineer.transform(df_temp_test_filtered)
    
    train_data = lgb.Dataset(X_train, label=df_temp_train['target_encoded'])
    
    model = lgb.train(
        lgb_params,
        train_data,
        num_boost_round=150
    )
    
    train_acc = (np.argmax(model.predict(X_train), axis=1) == df_temp_train['target_encoded']).mean()
    test_acc_raw = (np.argmax(model.predict(X_test_raw), axis=1) == df_temp_test['target_encoded']).mean()
    test_acc_filtered = (np.argmax(model.predict(X_test_filtered), axis=1) == df_temp_test_filtered['target_encoded']).mean()
    
    print(f"Train Acc: {train_acc:.4%}")
    print(f"Test Acc (raw): {test_acc_raw:.4%}, Drop: {train_acc - test_acc_raw:.4%}")
    print(f"Test Acc (filtered): {test_acc_filtered:.4%}, Drop: {train_acc - test_acc_filtered:.4%}")

if __name__ == '__main__':
    main()
