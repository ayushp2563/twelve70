# ml_pipeline/train.py
"""
============================================================================
LAMBDARANK LIGHTGBM TRAINING PIPELINE
============================================================================

Author: Recommendation Systems Architect
Purpose: Runs GBDT training on clicks, features, and query groups.
         Serializes the final LightGBM model to ONNX for Node.js consumption.
============================================================================
"""

import os
from features import hash_color_to_idx, calculate_tonal_contrast, calculate_seasonality_idx

# Mock training libs fallback for resilient production checks
try:
    import pandas as pd
    import numpy as np
    import lightgbm as lgb
    from sklearn.model_selection import GroupKFold
    import onnxmltools
    from onnxmltools import convert_lightgbm
    LIBS_AVAILABLE = True
except ImportError:
    LIBS_AVAILABLE = False

INPUT_CSV = "data/training_export.csv"           # Exported by InteractionStore from DB
INPUT_CSV_FALLBACK = "data/training_clicks.csv"   # Legacy fallback (pre-migration)
OUTPUT_ONNX = "models/outfit_ranker.onnx"

def build_pairwise_freq_index(ground_truth_csv="data/colorcombos.csv"):
    """
    Builds real pairwise co-occurrence counts between the midlayer color and
    each context garment color from the ground-truth combinations, mirroring
    the TypeScript graph engine's frequency counts. This must NOT be derived
    from the training label, otherwise the label leaks into the feature.
    """
    pair_counts = {}
    if not os.path.exists(ground_truth_csv):
        return pair_counts

    gt = pd.read_csv(ground_truth_csv)
    gt = gt[gt['top_outer_color'].notna() & (gt['top_outer_color'] != '-')]
    context_cols = ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color']

    for _, row in gt.iterrows():
        mid = str(row['top_outer_color']).strip().lower()
        for col in context_cols:
            other = str(row[col]).strip().lower()
            if other and other != '-' and other != 'nan':
                key = (mid, other)
                pair_counts[key] = pair_counts.get(key, 0) + 1

    return pair_counts

def compute_pairwise_freq(row, pair_counts):
    """
    Average co-occurrence count of the candidate color with the 4 context
    garments, looked up from the ground-truth pair index.
    """
    candidate = str(row['predicted_color']).strip().lower()
    context_cols = ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color']

    counts = []
    for col in context_cols:
        other = str(row[col]).strip().lower()
        if other and other != '-' and other != 'nan':
            counts.append(pair_counts.get((candidate, other), 0))

    return float(np.mean(counts)) if counts else 0.0

def load_and_extract_features():
    """
    Loads raw CSV data and preprocesses it into flat float features
    """
    # Try DB-exported file first, then legacy CSV
    csv_path = INPUT_CSV
    if not os.path.exists(csv_path):
        csv_path = INPUT_CSV_FALLBACK
        if not os.path.exists(csv_path):
            raise FileNotFoundError(f"❌ No training data found at: {INPUT_CSV} or {INPUT_CSV_FALLBACK}")
        print(f"⚠️  Using legacy CSV: {csv_path}")

    df = pd.read_csv(csv_path)
    print(f"📊 Preprocessed logs loaded. Extracting float feature vectors...")

    # Extract numerical arrays mirroring TS extractor
    df['topColorIdx']       = df['top_color'].apply(hash_color_to_idx)
    df['bottomColorIdx']    = df['bottom_color'].apply(hash_color_to_idx)
    df['outerwearColorIdx'] = df['outerwear_color'].apply(hash_color_to_idx)
    df['footwearColorIdx']  = df['footwear_color'].apply(hash_color_to_idx)
    df['candidateColorIdx'] = df['predicted_color'].apply(hash_color_to_idx)

    # Graph frequencies: real co-occurrence counts from ground-truth combos,
    # matching what candidate.frequency contains at inference time in TS.
    pair_counts = build_pairwise_freq_index()
    df['pairwiseFreq'] = df.apply(lambda r: compute_pairwise_freq(r, pair_counts), axis=1)

    # Styling calculations
    df['tonalContrast'] = df.apply(lambda r: calculate_tonal_contrast(r['predicted_color'], r['outerwear_color']), axis=1)
    df['userColorAffinity'] = 0.8
    df['seasonIdx'] = calculate_seasonality_idx(5) # May month index

    # Keep exactly the features expected by src/ml/featureExtractor.ts
    feature_cols = [
        'topColorIdx', 'bottomColorIdx', 'outerwearColorIdx', 'footwearColorIdx',
        'candidateColorIdx', 'pairwiseFreq', 'tonalContrast', 'userColorAffinity', 'seasonIdx'
    ]

    X = df[feature_cols].astype(np.float32)
    y = df['interaction_score'].astype(np.int32)
    groups = df['session_id'].astype(np.int32)

    return X, y, groups

def train_and_export():
    """
    Trains GBDT and exports to ONNX
    """
    if not LIBS_AVAILABLE:
        print("\n⚠️  ML libraries (lightgbm, scikit-learn, onnxmltools) not installed in Python.")
        if os.path.exists(OUTPUT_ONNX):
            print(f"   Skipping training. Keeping existing model at {OUTPUT_ONNX} untouched.\n")
            return
        print("   Skipping actual training run. Generating mock ONNX model for system integration testing...")
        os.makedirs(os.path.dirname(OUTPUT_ONNX), exist_ok=True)
        with open(OUTPUT_ONNX, 'w') as f:
            f.write('MOCK_ONNX_MODEL_FILE')
        print(f"✅ Generated mock model placeholder at: {OUTPUT_ONNX}\n")
        return

    X, y, groups = load_and_extract_features()

    print("⏳ Setting up LambdaRank GBDT parameters...")

    # Hold out 20% of sessions for validation so training quality is measurable.
    unique_sessions = groups.unique()
    rng = np.random.RandomState(42)
    rng.shuffle(unique_sessions)
    n_val = max(1, len(unique_sessions) // 5)
    val_sessions = set(unique_sessions[:n_val])

    val_mask = groups.isin(val_sessions).to_numpy()
    X_train, y_train, g_train = X[~val_mask], y[~val_mask], groups[~val_mask]
    X_val, y_val, g_val = X[val_mask], y[val_mask], groups[val_mask]

    # Group queries together for NDCG sorting (rows are ordered by session)
    q_train = X_train.groupby(g_train, sort=False).size().to_numpy()
    q_val = X_val.groupby(g_val, sort=False).size().to_numpy()

    train_data = lgb.Dataset(X_train, label=y_train, group=q_train)
    val_data = lgb.Dataset(X_val, label=y_val, group=q_val, reference=train_data)

    params = {
        'objective': 'lambdarank',
        'metric': 'ndcg',
        'ndcg_eval_at': [1, 3],
        'learning_rate': 0.05,
        'max_depth': 5,
        'num_leaves': 15,
        'min_data_in_leaf': 5,
        'verbose': -1
    }

    print("⏳ Fitting LightGBM model...")
    evals = {}
    model = lgb.train(
        params,
        train_data,
        num_boost_round=100,
        valid_sets=[val_data],
        valid_names=['validation'],
        callbacks=[lgb.early_stopping(20, verbose=False), lgb.record_evaluation(evals)]
    )
    for metric_name, values in evals.get('validation', {}).items():
        print(f"   Validation {metric_name} @ best iteration: {values[model.best_iteration - 1]:.4f}")
    print("✅ Model trained successfully.")

    print(f"⏳ Serializing model to ONNX format at {OUTPUT_ONNX}…")
    initial_types = [('input', onnxmltools.convert.common.data_types.FloatTensorType([None, X.shape[1]]))]
    onnx_model = convert_lightgbm(model, initial_types=initial_types)
    
    os.makedirs(os.path.dirname(OUTPUT_ONNX), exist_ok=True)
    onnxmltools.utils.save_model(onnx_model, OUTPUT_ONNX)
    print(f"✅ Production ONNX model compiled and saved.")

if __name__ == "__main__":
    try:
        train_and_export()
    except Exception as e:
        print(f"❌ Pipeline failed: {e}")
        # Never overwrite an existing (possibly valid) model with a placeholder.
        # Only create a mock file if no model exists at all, so Node can boot.
        if not os.path.exists(OUTPUT_ONNX):
            os.makedirs(os.path.dirname(OUTPUT_ONNX), exist_ok=True)
            with open(OUTPUT_ONNX, 'w') as f:
                f.write('MOCK_ONNX_MODEL_FILE')
            print(f"⚠️  Wrote placeholder model to {OUTPUT_ONNX} (no previous model existed).")
        else:
            print(f"⚠️  Keeping existing model at {OUTPUT_ONNX} untouched.")
        raise SystemExit(1)
