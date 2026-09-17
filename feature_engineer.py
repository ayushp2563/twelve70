#!/usr/bin/env python3
"""
feature_engineer.py

Color Feature Engineering System for Twelve70.
Converts categorical outfit colors into numerical features based on color theory,
lightness, position frequency, pairwise co-occurrence, and color family harmony.
Can also perform feature importance analysis using positive vs. negative classification.
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

# Position mapping
POSITION_MAP = {
    'top_color': 'top',
    'bottom_color': 'bottom',
    'outerwear_color': 'outerwear',
    'footwear_color': 'shoes',
    'top_outer_color': 'midlayer'
}

COLOR_COLS = list(POSITION_MAP.keys())

# Color family list for label encoding mapping
FAMILY_LIST = ['Neutral', 'Warm', 'Cool', 'Earth', 'Pastel', 'Pattern']
FAMILY_TO_NUM = {fam: idx / (len(FAMILY_LIST) - 1) for idx, fam in enumerate(FAMILY_LIST)}

# Harmony Table from sequentialFilter.ts
HARMONY_TABLE = {
    'Neutral':  ['Neutral', 'Warm', 'Cool', 'Earth', 'Pastel', 'Pattern'],
    'Warm':     ['Neutral', 'Cool', 'Earth'],
    'Cool':     ['Neutral', 'Warm', 'Earth', 'Pastel'],
    'Earth':    ['Neutral', 'Cool', 'Pastel', 'Warm'],
    'Pastel':   ['Neutral', 'Cool', 'Earth'],
    'Pattern':  ['Neutral', 'Cool', 'Earth']
}

def parse_args():
    parser = argparse.ArgumentParser(description="Twelve70 Color Feature Engineering System")
    parser.add_argument(
        '--input', 
        required=True, 
        help="Path to raw/cleaned outfits CSV (e.g. data/colorcombos.csv or cleaned_outfits.csv)"
    )
    parser.add_argument(
        '--output', 
        default='feature_matrix.csv', 
        help="Path to save the output numerical feature matrix CSV (default: feature_matrix.csv)"
    )
    parser.add_argument(
        '--families-json', 
        default='color_families.json', 
        help="Path to color_families.json mapping file"
    )
    parser.add_argument(
        '--lightness-json', 
        default='color_lightness.json', 
        help="Path to color_lightness.json mapping file"
    )
    parser.add_argument(
        '--analyze', 
        action='store_true', 
        help="Run feature importance analysis by training a Random Forest classifier"
    )
    parser.add_argument(
        '--output-importance', 
        default='feature_importance.json', 
        help="Path to save feature importance report (default: feature_importance.json)"
    )
    return parser.parse_args()

def load_json_mapping(filepath):
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Mapping file not found: {filepath}. Run scripts/generate_mappings.py first.")
    with open(filepath, 'r') as f:
        data = json.load(f)
    # Standardize keys to lowercase for robust lookup
    return {k.lower(): v for k, v in data.items()}

class ColorFeatureEngineer:
    def __init__(self, families_map, lightness_map):
        self.families_map = families_map
        self.lightness_map = lightness_map
        
        # Statistics to be fitted on historical data
        self.position_freq = {}
        self.pair_freq = {}
        self.max_pos_freq = {}
        self.max_pair_freq = {}
        
    def fit(self, df):
        """
        Fits frequencies and probabilities on a historical database of outfits.
        """
        n_records = len(df)
        if n_records == 0:
            return
            
        # 1. Fit position frequencies
        for col in COLOR_COLS:
            self.position_freq[col] = {}
            counts = df[col].fillna('-').str.lower().value_counts()
            max_count = counts.max() if not counts.empty else 1
            self.max_pos_freq[col] = max_count
            
            for val, count in counts.items():
                self.position_freq[col][val] = count / max_count
                
        # 2. Fit pairwise frequencies (all 10 slot pairs)
        for i in range(len(COLOR_COLS)):
            for j in range(i + 1, len(COLOR_COLS)):
                col_a = COLOR_COLS[i]
                col_b = COLOR_COLS[j]
                pair_key = f"{col_a}_{col_b}"
                
                self.pair_freq[pair_key] = {}
                joint_counts = df.groupby([col_a, col_b]).size()
                max_joint = joint_counts.max() if not joint_counts.empty else 1
                self.max_pair_freq[pair_key] = max_joint
                
                for (val_a, val_b), count in joint_counts.items():
                    k = f"{str(val_a).lower()}_{str(val_b).lower()}"
                    self.pair_freq[pair_key][k] = count / max_joint

    def get_family_numeric(self, color_name):
        color_lower = str(color_name).lower().strip()
        fam = self.families_map.get(color_lower, 'Neutral')
        return FAMILY_TO_NUM.get(fam, 0.0)

    def get_lightness(self, color_name):
        color_lower = str(color_name).lower().strip()
        return self.lightness_map.get(color_lower, 0.5)

    def get_pos_frequency(self, col, color_name):
        color_lower = str(color_name).lower().strip()
        return self.position_freq.get(col, {}).get(color_lower, 0.0)

    def get_pair_frequency(self, col_a, color_a, col_b, color_b):
        pair_key = f"{col_a}_{col_b}"
        val_a = str(color_a).lower().strip()
        val_b = str(color_b).lower().strip()
        k = f"{val_a}_{val_b}"
        return self.pair_freq.get(pair_key, {}).get(k, 0.0)

    def get_harmony_score(self, target_col, outfit_row):
        """
        Computes the ratio of other garments that are harmonious with the target garment's family.
        """
        target_color = outfit_row[target_col]
        target_fam = self.families_map.get(str(target_color).lower().strip(), 'Neutral')
        harmonious_list = HARMONY_TABLE.get(target_fam, [])
        
        matches = 0
        total = 0
        for col in COLOR_COLS:
            if col == target_col:
                continue
            other_color = outfit_row[col]
            if pd.isna(other_color) or other_color == '-':
                continue
            other_fam = self.families_map.get(str(other_color).lower().strip(), 'Neutral')
            if other_fam in harmonious_list:
                matches += 1
            total += 1
            
        return matches / total if total > 0 else 1.0

    def transform(self, df):
        """
        Transforms categorical outfit rows into a numerical feature matrix.
        Returns a DataFrame of size (len(df), 30) with all normalized features.
        """
        feature_rows = []
        
        for _, row in df.iterrows():
            features = {}
            
            # A. Lightness Features (5 features)
            for col in COLOR_COLS:
                features[f"{POSITION_MAP[col]}_lightness"] = self.get_lightness(row[col])
                
            # B. Family Features (5 features)
            for col in COLOR_COLS:
                features[f"{POSITION_MAP[col]}_family"] = self.get_family_numeric(row[col])
                
            # C. Position Frequency Features (5 features)
            for col in COLOR_COLS:
                features[f"{POSITION_MAP[col]}_pos_freq"] = self.get_pos_frequency(col, row[col])
                
            # D. Pairwise Frequency Features (10 features)
            for i in range(len(COLOR_COLS)):
                for j in range(i + 1, len(COLOR_COLS)):
                    col_a = COLOR_COLS[i]
                    col_b = COLOR_COLS[j]
                    features[f"{POSITION_MAP[col_a]}_{POSITION_MAP[col_b]}_freq"] = \
                        self.get_pair_frequency(col_a, row[col_a], col_b, row[col_b])
                        
            # E. Family Harmony Features (5 features)
            for col in COLOR_COLS:
                features[f"{POSITION_MAP[col]}_harmony_score"] = self.get_harmony_score(col, row)
                
            feature_rows.append(features)
            
        return pd.DataFrame(feature_rows)

def run_analysis(engineer, df_positive, output_importance_path):
    """
    Generates synthetic negative samples, constructs features, trains a Random Forest Classifier,
    and returns feature importances.
    """
    print("Generating negative samples for classification analysis...")
    n_positive = len(df_positive)
    
    # Sample negative combinations by randomly shuffling each column independently
    neg_data = {}
    for col in COLOR_COLS:
        neg_data[col] = df_positive[col].sample(n=n_positive, replace=True).values
        
    df_negative = pd.DataFrame(neg_data)
    
    # Label datasets
    df_positive['target'] = 1
    df_negative['target'] = 0
    
    # Combine positive and negative samples
    df_combined = pd.concat([df_positive, df_negative], ignore_index=True)
    
    # Split rows BEFORE fitting frequency statistics, so test rows never
    # contribute to the frequency features they are evaluated on (no leakage).
    df_train_rows, df_test_rows = train_test_split(df_combined, test_size=0.2, random_state=42)
    
    # Refit frequency statistics on the positive training rows only
    engineer_cv = ColorFeatureEngineer(engineer.families_map, engineer.lightness_map)
    engineer_cv.fit(df_train_rows[df_train_rows['target'] == 1][COLOR_COLS])
    
    print("Extracting features for Random Forest classifier...")
    X_train = engineer_cv.transform(df_train_rows[COLOR_COLS])
    X_test = engineer_cv.transform(df_test_rows[COLOR_COLS])
    y_train = df_train_rows['target']
    y_test = df_test_rows['target']
    X = pd.concat([X_train, X_test], ignore_index=True)
    
    print("Training Random Forest Classifier...")
    model = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
    model.fit(X_train, y_train)
    
    accuracy = model.score(X_test, y_test)
    print(f"Model Classification Accuracy: {accuracy:.4f}")
    
    # Extract feature importances
    importances = model.feature_importances_
    feature_names = X.columns
    
    importance_list = []
    for name, imp in zip(feature_names, importances):
        importance_list.append({"feature": name, "importance": float(imp)})
        
    # Sort descending
    importance_list.sort(key=lambda x: x['importance'], reverse=True)
    
    report = {
        "model_accuracy": accuracy,
        "feature_importances": importance_list,
        "feature_groups_summary": analyze_feature_groups(importance_list)
    }
    
    with open(output_importance_path, 'w') as f:
        json.dump(report, f, indent=2)
        
    print(f"✅ Feature importance report saved to: {output_importance_path}")
    return report

def analyze_feature_groups(importance_list):
    """Summarizes feature importances grouped by feature category"""
    groups = {
        "Lightness (0-1)": 0.0,
        "Color Family (Label Encoded)": 0.0,
        "Position Frequency": 0.0,
        "Pairwise Co-occurrence Frequency": 0.0,
        "Color Family Harmony Score": 0.0
    }
    
    for item in importance_list:
        feat = item['feature']
        imp = item['importance']
        
        if 'lightness' in feat:
            groups["Lightness (0-1)"] += imp
        elif 'family' in feat:
            groups["Color Family (Label Encoded)"] += imp
        elif 'pos_freq' in feat:
            groups["Position Frequency"] += imp
        elif 'harmony' in feat:
            groups["Color Family Harmony Score"] += imp
        else:
            groups["Pairwise Co-occurrence Frequency"] += imp
            
    # Round values
    return {k: round(v, 4) for k, v in groups.items()}

def main():
    args = parse_args()
    
    print(f"Initializing feature engineering system with mapping files...")
    families_map = load_json_mapping(args.families_json)
    lightness_map = load_json_mapping(args.lightness_json)
    
    print(f"Loading raw outfit dataset: {args.input}")
    df_raw = pd.read_csv(args.input)
    
    # Clean column strings to ensure matching
    for col in COLOR_COLS:
        if col in df_raw.columns:
            df_raw[col] = df_raw[col].astype(str).str.strip().str.lower()
            
    engineer = ColorFeatureEngineer(families_map, lightness_map)
    print("Fitting frequencies and probabilities on input dataset...")
    engineer.fit(df_raw)
    
    print("Transforming dataset to numerical feature matrix...")
    df_features = engineer.transform(df_raw)
    
    # Check feature count
    n_features = df_features.shape[1]
    print(f"Extracted {n_features} features per row.")
    
    # Save feature matrix
    df_features.to_csv(args.output, index=False)
    print(f"✅ Feature matrix saved to: {args.output}")
    
    # Run classification analysis if requested
    if args.analyze:
        run_analysis(engineer, df_raw, args.output_importance)

if __name__ == '__main__':
    main()
