# ml_pipeline/negative_sampling.py
"""
============================================================================
NEGATIVE SAMPLING PREPROCESSING PIPELINE
============================================================================

Purpose: Generates synthetic negative examples (clashing outfits, label y=0)
         from positive ground truth records to build the dataset.
============================================================================
"""

import pandas as pd
import random

def generate_negative_samples(input_csv_path, output_csv_path):
    """
    Reads ground truth combinations and generates negative samples by shuffling 
    garment colors to produce unharmonious configurations.
    """
    df = pd.read_csv(input_csv_path)
    
    positives = []
    negatives = []
    
    # Keep track of all distinct colors to use for negative sampling
    all_outers = [c for c in df['top_outer_color'].unique() if c != '-']
    if not all_outers:
        all_outers = ['black', 'charcoal', 'grey', 'white', 'navy']

    session_id = 0
    for idx, row in df.iterrows():
        # Exclude rows without a valid outer color
        if row['top_outer_color'] == '-' or not row['top_outer_color']:
            continue
            
        session_id += 1
        
        # 1. POSITIVE EXAMPLE (y=2)
        positives.append({
            'session_id': session_id,
            'top_color': row['top_color'],
            'bottom_color': row['bottom_color'],
            'outerwear_color': row['outerwear_color'],
            'footwear_color': row['footwear_color'],
            'predicted_color': row['top_outer_color'],
            'interaction_score': 2  # Label 2 for ground-truth highly harmonious
        })
        
        # 2. NEGATIVE EXAMPLES (y=0)
        # Choose 3 random outer colors that are NOT the correct one
        neg_candidates = [c for c in all_outers if c != row['top_outer_color']]
        if len(neg_candidates) > 3:
            neg_samples = random.sample(neg_candidates, 3)
        else:
            neg_samples = neg_candidates
            
        for neg_col in neg_samples:
            negatives.append({
                'session_id': session_id,
                'top_color': row['top_color'],
                'bottom_color': row['bottom_color'],
                'outerwear_color': row['outerwear_color'],
                'footwear_color': row['footwear_color'],
                'predicted_color': neg_col,
                'interaction_score': 0  # Label 0 for random synthetic clashing
            })
            
    # Combine into a final preprocessed training dataset
    combined = pd.DataFrame(positives + negatives)
    combined.to_csv(output_csv_path, index=False)
    print(f"✅ Preprocessed dataset built: {len(combined):,} rows saved to {output_csv_path}")

if __name__ == "__main__":
    generate_negative_samples("data/colorcombos.csv", "data/training_clicks.csv")
