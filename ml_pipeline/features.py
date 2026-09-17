# ml_pipeline/features.py
"""
============================================================================
FASHION OUTFIT FEATURE ENGINEERING UTILITIES (PYTHON)
============================================================================

Author: ML Systems Architect
Purpose: Defines the preprocessing feature extraction functions used during
         ranking model training. Must mirror TypeScript logic perfectly.
============================================================================
"""

import math
import os
import pandas as pd

class ColorAliasResolver:
    def __init__(self):
        self.id_to_name = {}
        self.aliases = {}
        self.active_colors = set()
        self.initialized = False

    def initialize(self, data_dir='data'):
        colors_path = os.path.join(data_dir, 'colors.csv')
        if not os.path.exists(colors_path):
            return

        try:
            df = pd.read_csv(colors_path)
            # First pass: ID to name mapping
            for _, row in df.iterrows():
                cid = str(row['id']).strip()
                name = str(row['name']).strip().lower()
                self.id_to_name[cid] = name

            # Second pass: load aliases
            for _, row in df.iterrows():
                name = str(row['name']).strip().lower()
                is_alias = str(row['is_alias']) == '1' or row['is_alias'] == 1
                if is_alias:
                    targets = []
                    for col in ['alias_id', 'alias_id2', 'alias_id3']:
                        target_id = str(row[col]).strip()
                        if target_id and target_id != 'nan' and target_id != 'NULL' and target_id != '' and target_id in self.id_to_name:
                            targets.append(self.id_to_name[target_id])
                    if targets:
                        self.aliases[name] = targets
                        
            # Populate active colors from colorcombos.csv if it exists
            combos_path = os.path.join(data_dir, 'colorcombos.csv')
            if os.path.exists(combos_path):
                df_combos = pd.read_csv(combos_path)
                for col in ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color', 'top_outer_color']:
                    if col in df_combos.columns:
                        self.active_colors.update(df_combos[col].dropna().str.strip().str.lower().unique())
            
            # Inject patterns
            patterns_dir = 'public/patterns'
            if os.path.exists(patterns_dir):
                for f in os.listdir(patterns_dir):
                    if f.endswith('.png'):
                        self.active_colors.add(f[:-4].strip().lower())
                        
            self.initialized = True
        except Exception as e:
            print(f"Error initializing ColorAliasResolver in python: {e}")

    def resolve(self, color_name):
        if not color_name:
            return ''
        normalized = str(color_name).lower().strip().replace('-', '').replace('_', '').replace(' ', '')
        
        if not self.initialized:
            self.initialize()
            
        if normalized in self.active_colors:
            return normalized

        targets = self.aliases.get(normalized)
        if targets:
            for target in targets:
                if target in self.active_colors:
                    return target
            return targets[0]

        # Basic string parsing (legacy alias logic)
        if 'offwhite' in normalized or 'ivory' in normalized or 'cream' in normalized:
            if 'white' in self.active_colors: return 'white'
            if 'offwhite' in self.active_colors: return 'offwhite'
        if 'charcoal' in normalized or 'darkgrey' in normalized:
            if 'charcoal' in self.active_colors: return 'charcoal'
        if 'navy' in normalized or 'midnight' in normalized:
            if 'navy' in self.active_colors: return 'navy'
        if 'burgundy' in normalized or 'maroon' in normalized:
            if 'burgundy' in self.active_colors: return 'burgundy'
        if 'olive' in normalized or 'armygreen' in normalized:
            if 'olive' in self.active_colors: return 'olive'
            if 'olivegreen' in self.active_colors: return 'olivegreen'
        if 'tan' in normalized or 'beige' in normalized:
            if 'tan' in self.active_colors: return 'tan'

        # Substring fallback
        for active in self.active_colors:
            if normalized in active or active in normalized:
                return active

        return normalized

color_alias_resolver = ColorAliasResolver()

def _to_int32(value):
    """Emulates JavaScript's 32-bit signed integer overflow semantics."""
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value

def hash_color_raw(color_name):
    """
    Hashes a color name WITHOUT alias resolution, byte-for-byte identical to
    hashColorToIdx in src/ml/featureExtractor.ts. JavaScript's `<<` operator
    wraps at 32-bit signed ints, so we must emulate that here — plain Python
    integer arithmetic silently diverges for longer names, which would train
    the model on different color buckets than it sees at serving time.
    """
    if not color_name or color_name == '-' or color_name == '':
        return 0
    normalized = str(color_name).lower().replace('-', '').replace('_', '').replace(' ', '')

    # In JS, only the `<<` operator coerces to int32; the surrounding
    # subtraction and addition are ordinary (unwrapped) number arithmetic.
    hash_val = 0
    for char in normalized:
        shifted = _to_int32(_to_int32(hash_val) << 5)
        hash_val = ord(char) + (shifted - hash_val)
    return abs(hash_val) % 50

def hash_color_to_idx(color_name):
    """
    Maps a color name string to a deterministic integer hash index (0 to 49),
    resolving aliases to canonical colors first.
    """
    if not color_name or color_name == '-' or color_name == '':
        return 0
    resolved = color_alias_resolver.resolve(color_name)
    return hash_color_raw(resolved)

# Map deep colors vs pastels/lights
DARK_COL_SUBSTRINGS = ['black', 'dark', 'charcoal', 'navy', 'indigo', 'burgundy', 
                       'maroon', 'oxblood', 'tobacco', 'brown', 'forest', 'olive', 'midnight']
LIGHT_COL_SUBSTRINGS = ['light', 'white', 'sand', 'sail', 'photondust', 'mint', 'lavender', 'sage', 'beige']

def is_dark_color(color_name):
    """
    Returns True if color represents a dark deep tone, False if light/pastel
    """
    if not color_name or color_name == '-':
        return True
    c = color_name.lower().replace('-', '').replace('_', '').replace(' ', '')
    if any(sub in c for sub in LIGHT_COL_SUBSTRINGS):
        return False
    if any(sub in c for sub in DARK_COL_SUBSTRINGS):
        return True
    if 'grey' in c or 'gray' in c:
        return 'light' not in c
    return True

def calculate_tonal_contrast(color_a, color_b):
    """
    Returns 1.0 for high tonal break (dark + light), 0.0 for low contrast
    """
    if not color_a or not color_b or color_a == '-' or color_b == '-':
        return 0.5
    return 1.0 if is_dark_color(color_a) != is_dark_color(color_b) else 0.0

def calculate_seasonality_idx(month_idx):
    """
    Sine-wave seasonality coefficient based on month
    """
    return math.sin((month_idx / 12.0) * math.pi * 2) if month_idx is not None else 0.0
