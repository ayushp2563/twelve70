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
    
    engineer = train_baseline.ColorFeatureEngineer4Inputs(families_map, lightness_map)
    engineer.fit(df_temp_train)
    
    X_train = engineer.transform(df_temp_train)
    X_test = engineer.transform(df_temp_test)
    
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
    
    train_data = lgb.Dataset(X_train, label=df_temp_train['target_encoded'])
    
    for rounds in [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150]:
        model = lgb.train(
            lgb_params,
            train_data,
            num_boost_round=rounds
        )
        train_acc = (np.argmax(model.predict(X_train), axis=1) == df_temp_train['target_encoded']).mean()
        test_acc = (np.argmax(model.predict(X_test), axis=1) == df_temp_test['target_encoded']).mean()
        print(f"Rounds: {rounds:3d} | Train Acc: {train_acc:.4%} | Test Acc: {test_acc:.4%} | Drop: {train_acc - test_acc:.4%}")

if __name__ == '__main__':
    test()
