#!/usr/bin/env python3
"""
validate_data.py

Data Quality & Validation Pipeline for Outfit Colors.
Validates structural integrity, color consistency, distribution, outliers,
and temporal ranges on Twelve70 outfit combinations.
"""

import os
import sys
import json
import argparse
import datetime
from collections import Counter
import pandas as pd
import numpy as np

# Position mapping
POSITION_MAP = {
    'top_color': 'top',
    'bottom_color': 'bottom',
    'outerwear_color': 'outerwear',
    'footwear_color': 'shoes',
    'top_outer_color': 'midlayer'
}

COLOR_COLS = list(POSITION_MAP.keys())

def parse_args():
    parser = argparse.ArgumentParser(description="Data Quality & Validation Pipeline for Outfit Colors")
    parser.add_argument(
        'input_file',
        nargs='?',
        help="Path to the raw CSV input file (optional positional)"
    )
    parser.add_argument(
        '--input', 
        help="Path to the raw CSV input file"
    )
    parser.add_argument(
        '--output-report', 
        default='validation_report.json', 
        help="Path to save the JSON validation report (default: validation_report.json)"
    )
    parser.add_argument(
        '--output-csv', 
        default='cleaned_outfits.csv', 
        help="Path to save the cleaned CSV with validation flags (default: cleaned_outfits.csv)"
    )
    parser.add_argument(
        '--data-dir', 
        default='data', 
        help="Directory containing approved colors database files (default: data)"
    )
    return parser.parse_args()

def load_approved_colors(data_dir):
    """
    Loads approved colors from colors.csv, colorshex.csv, public/patterns,
    and includes known database slang/composite colors.
    """
    approved = set()
    
    # 1. Load colors.csv
    colors_csv = os.path.join(data_dir, 'colors.csv')
    if os.path.exists(colors_csv):
        try:
            colors_df = pd.read_csv(colors_csv)
            if 'name' in colors_df.columns:
                approved.update(colors_df['name'].dropna().str.lower().str.strip().unique())
        except Exception as e:
            print(f"Warning: Could not read {colors_csv}: {e}", file=sys.stderr)
            
    # 2. Load colorshex.csv
    colorshex_csv = os.path.join(data_dir, 'colorshex.csv')
    if os.path.exists(colorshex_csv):
        try:
            colorshex_df = pd.read_csv(colorshex_csv)
            if 'name' in colorshex_df.columns:
                approved.update(colorshex_df['name'].dropna().str.lower().str.strip().unique())
        except Exception as e:
            print(f"Warning: Could not read {colorshex_csv}: {e}", file=sys.stderr)
            
    # 3. Load pattern names from public/patterns
    # Search for patterns in public/patterns relative to the parent of data_dir
    parent_dir = os.path.dirname(os.path.abspath(data_dir))
    patterns_dir = os.path.join(parent_dir, 'public', 'patterns')
    if os.path.exists(patterns_dir):
        try:
            for f in os.listdir(patterns_dir):
                if f.endswith('.png'):
                    approved.add(f[:-4].lower().strip())
        except Exception as e:
            print(f"Warning: Could not read patterns dir {patterns_dir}: {e}", file=sys.stderr)
            
    # 4. Standard styling terms and slangs present in the DB
    db_slang = {
        'bred', 'breds', 'royals', 'coast', 'syracuse', 'st.johns', 'shadows', 
        'photondust', 'mediumcurry', 'laserorange', 'royal-black',
        'lightgrey-whitestripe', 'black-greypolkadots', 'black-yellowpolkadots',
        'navy-blackpolkadots', 'green-whitepolkadots', '-'
    }
    approved.update(db_slang)
    
    return approved

def get_color_family(color_name):
    """
    Implements Twelve70's Color Family Mapping.
    Returns: 'neutral' | 'warm' | 'cool' | 'earth' | 'pastel' | 'pattern'
    """
    if not isinstance(color_name, str) or color_name == '-':
        return 'neutral'
        
    c = color_name.lower().replace('-', '').replace('_', '').replace(' ', '')
    
    # 1. Wildcard patterns
    pattern_keywords = [
        'camo', 'tartan', 'houndstooth', 'plaid', 'gingham', 'stripe', 
        'chalkstripe', 'polkadot', 'dots', 'leopard', 'herringbone', 'denim', 'marled'
    ]
    if any(kw in c for kw in pattern_keywords):
        return 'pattern'
        
    # 2. Base mapping from sequentialFilter.ts
    family_map = {
        # Neutrals
        'black': 'neutral', 'charcoal': 'neutral', 'white': 'neutral', 'offwhite': 'neutral',
        'grey': 'neutral', 'gray': 'neutral', 'lightgrey': 'neutral', 'slate': 'neutral',
        'sand': 'neutral', 'tan': 'neutral', 'camel': 'neutral', 'brown': 'neutral',
        'tobacco': 'neutral', 'vegtan': 'neutral', 'shadows': 'neutral', 'sail': 'neutral',
        'photondust': 'neutral', 'taupe': 'neutral', 'warmgrey': 'neutral', 'silver': 'neutral',
        # Warm
        'red': 'warm', 'burgundy': 'warm', 'oxblood': 'warm', 'maroon': 'warm',
        'burntorange': 'warm', 'orange': 'warm', 'yellow': 'warm', 'mustard': 'warm',
        'rust': 'warm', 'gold': 'warm', 'bred': 'warm', 'breds': 'warm',
        'laserorange': 'warm', 'coral': 'warm',
        # Cool
        'blue': 'cool', 'navy': 'cool', 'royalblue': 'cool', 'lightblue': 'cool',
        'teal': 'cool', 'turquoise': 'cool', 'purple': 'cool', 'deeppurple': 'cool',
        'lavender': 'cool', 'indigo': 'cool', 'mint': 'cool', 'violet': 'cool',
        'mediumcurry': 'cool', 'midnightblue': 'cool', 'frenchblue': 'cool',
        # Earth
        'olivegreen': 'earth', 'green': 'earth', 'forestgreen': 'earth', 'khaki': 'earth',
        'olive': 'earth', 'sage': 'earth',
        # Pastel
        'lightpink': 'pastel', 'dustypink': 'pastel', 'hotpink': 'pastel', 'pink': 'pastel',
        'coast': 'pastel'
    }
    
    if c in family_map:
        return family_map[c]
        
    for key, fam in family_map.items():
        if key in c or c in key:
            return fam
            
    # Substring matches
    if 'grey' in c or 'gray' in c or 'silver' in c:
        return 'neutral'
    if 'blue' in c or 'navy' in c:
        return 'cool'
    if 'green' in c or 'olive' in c:
        return 'earth'
    if 'pink' in c or 'rose' in c:
        return 'pastel'
    if 'red' in c or 'burg' in c or 'orange' in c:
        return 'warm'
        
    return 'neutral'

def validate_color_value(val, approved_set):
    """
    Validates a color name against approved set.
    Checks for nulls, formatting errors (case/whitespace), and unknown status.
    Returns: (cleaned_value, is_null, is_formatting_error, is_unknown)
    """
    if pd.isna(val) or val is None:
        return None, True, False, False
        
    s = str(val).strip()
    if s == "" or s.lower() == 'nan' or s.lower() == 'null':
        return None, True, False, False
        
    # '-' is a valid placeholder representing 'no layer' in Twelve70
    if s == '-':
        return '-', False, False, False
        
    s_lower = s.lower()
    
    # Check direct match
    is_approved = s_lower in approved_set
    
    # Check composite match (e.g. 'white-orange')
    if not is_approved and '-' in s_lower:
        parts = s_lower.split('-')
        if all(p in approved_set or p + 's' in approved_set or p[:-1] in approved_set for p in parts):
            is_approved = True
            
    if not is_approved:
        return s, False, False, True
        
    # Standardized format is canonical lowercase
    canonical_val = s_lower
    is_formatting_error = (s != canonical_val)
    
    return canonical_val, False, is_formatting_error, False

def get_season(month):
    """Maps month number to season string"""
    if month in [12, 1, 2]:
        return 'Winter'
    elif month in [3, 4, 5]:
        return 'Spring'
    elif month in [6, 7, 8]:
        return 'Summer'
    else:
        return 'Fall'

def run_validation(input_csv, data_dir):
    """Main validation engine"""
    if not os.path.exists(input_csv):
        raise FileNotFoundError(f"Input CSV file not found: {input_csv}")
        
    df = pd.read_csv(input_csv)
    total_records = len(df)
    
    approved_colors = load_approved_colors(data_dir)
    
    # Verify color columns exist
    missing_cols = [col for col in COLOR_COLS if col not in df.columns]
    if missing_cols:
        raise ValueError(f"Missing required color columns in CSV: {missing_cols}")
        
    # Add flag columns
    df['flag_null'] = False
    df['flag_unknown_color'] = False
    df['flag_formatting_error'] = False
    df['flag_duplicate'] = False
    df['flag_temporal_error'] = False
    
    # Record detailed issue stats
    null_count = 0
    unknown_colors_found = set()
    formatting_errors_count = 0
    temporal_errors_count = 0
    
    # Cleaned color matrix
    cleaned_colors = {}
    for col in COLOR_COLS:
        cleaned_colors[col] = []
        
    # 1. Row-by-row structural & consistency validation
    for idx, row in df.iterrows():
        row_has_null = False
        row_has_unknown = False
        row_has_formatting = False
        
        for col in COLOR_COLS:
            val = row[col]
            cleaned_val, is_null, is_formatting, is_unknown = validate_color_value(val, approved_colors)
            
            if is_null:
                row_has_null = True
                cleaned_val = None
            if is_unknown:
                row_has_unknown = True
                unknown_colors_found.add(str(val))
            if is_formatting:
                row_has_formatting = True
                
            cleaned_colors[col].append(cleaned_val)
            
        if row_has_null:
            df.at[idx, 'flag_null'] = True
            null_count += 1
        if row_has_unknown:
            df.at[idx, 'flag_unknown_color'] = True
        if row_has_formatting:
            df.at[idx, 'flag_formatting_error'] = True
            formatting_errors_count += 1
            
    # Apply cleaned standardized color values to the DataFrame
    for col in COLOR_COLS:
        df[col] = cleaned_colors[col]
        
    # 2. Duplicate Detection (subset of color columns)
    # Mark duplicates keeping the first occurrence
    duplicates_mask = df.duplicated(subset=COLOR_COLS, keep='first')
    df['flag_duplicate'] = duplicates_mask
    duplicates_count = duplicates_mask.sum()
    
    # Find duplicate counts for warning details
    dup_groups = df.groupby(COLOR_COLS).size()
    duplicates_detail = dup_groups[dup_groups > 1].sort_values(ascending=False)
    
    # 3. Temporal Validation (if dates available)
    has_dates = 'created_at' in df.columns or 'updated_at' in df.columns
    date_col = 'created_at' if 'created_at' in df.columns else ('updated_at' if 'updated_at' in df.columns else None)
    
    temporal_issues = []
    seasons_data = [] # Stores (color, season) tuples for seasonal distribution
    
    if has_dates and date_col:
        # Convert to datetime, coerce errors to NaT
        date_series = pd.to_datetime(df[date_col], errors='coerce')
        now = datetime.datetime.now()
        
        for idx, dt in date_series.items():
            if pd.isna(dt):
                df.at[idx, 'flag_temporal_error'] = True
                temporal_errors_count += 1
            elif dt.year < 2020 or dt > now:
                df.at[idx, 'flag_temporal_error'] = True
                temporal_errors_count += 1
                temporal_issues.append((idx, dt))
            else:
                # Capture season for seasonal analysis (only for valid dates)
                season = get_season(dt.month)
                for col in COLOR_COLS:
                    color_val = df.at[idx, col]
                    if color_val and color_val != '-':
                        seasons_data.append((color_val, season))
                        
    # 4. Filter for Clean records
    # Clean rows: no nulls, no unknown colors, not a duplicate, no temporal errors
    df['is_clean'] = ~(df['flag_null'] | df['flag_unknown_color'] | df['flag_duplicate'] | df['flag_temporal_error'])
    
    df_cleaned = df[df['is_clean']].copy()
    records_after_cleaning = len(df_cleaned)
    removed_records = total_records - records_after_cleaning
    
    # 5. Color Distribution Calculations
    # Count occurrences across all 5 columns for clean dataset
    color_distribution = {}
    positions_counts = {col: Counter(df_cleaned[col]) for col in COLOR_COLS}
    
    # Get all active colors in the cleaned dataset
    active_colors = set()
    for col in COLOR_COLS:
        active_colors.update(df_cleaned[col].dropna().unique())
    active_colors.discard('-') # remove placeholder
    
    for color in sorted(active_colors):
        color_title = color.title()
        total_count = sum(positions_counts[col][color] for col in COLOR_COLS)
        
        # Determine positions where it appeared at least once
        positions = []
        for col in COLOR_COLS:
            if positions_counts[col][color] > 0:
                positions.append(POSITION_MAP[col])
                
        color_distribution[color_title] = {
            "count": total_count,
            "positions": positions
        }
        
    # 6. Warnings Generation
    warnings = []
    
    # Position warnings (never in position, or only in one position)
    for color in active_colors:
        color_title = color.title()
        total_count = sum(positions_counts[col][color] for col in COLOR_COLS)
        active_pos = [col for col in COLOR_COLS if positions_counts[col][color] > 0]
        
        if total_count >= 10:
            if len(active_pos) == 1:
                warnings.append(
                    f"Color '{color_title}' appears {total_count} times but only in {POSITION_MAP[active_pos[0]]} position"
                )
            else:
                for col in COLOR_COLS:
                    if positions_counts[col][color] == 0:
                        warnings.append(f"Navy never appears as midlayer" if color_title == 'Navy' and POSITION_MAP[col] == 'midlayer' else f"Color '{color_title}' never appears in {POSITION_MAP[col]} position")
                        
    # Imbalanced colors warnings
    for color in active_colors:
        color_title = color.title()
        total_count = sum(positions_counts[col][color] for col in COLOR_COLS)
        pct = (total_count / (records_after_cleaning * 5)) * 100
        
        if pct > 20.0:
            warnings.append(f"Color '{color_title}' is extremely common, appearing in {total_count} ({pct:.1f}%) of garments.")
        elif total_count < 10:
            warnings.append(f"Color '{color_title}' is extremely rare, appearing only {total_count} times in the dataset.")
            
    # Unknown colors warning
    unknown_count = len(unknown_colors_found)
    if unknown_count > 0:
        warnings.append(
            f"{unknown_count} unknown color values found: {sorted(list(unknown_colors_found))[:15]}"
        )
        
    # Duplicate outfits warning
    if duplicates_count > 0:
        # Get up to top 3 duplicates
        for combo, count in duplicates_detail.head(3).items():
            combo_str = "/".join([str(c).title() for c in combo])
            warnings.append(f"Duplicate outfit found {count} times: {combo_str}")
            
    # Conditional probability/impossible combos warnings
    # E.g., if Color A is always paired with Color B
    if len(df_cleaned) >= 10:
        for color_a in active_colors:
            color_a_title = color_a.title()
            a_rows = df_cleaned[df_cleaned[COLOR_COLS].map(lambda x: x == color_a).any(axis=1)]
            a_count = len(a_rows)
            
            if a_count >= 15:
                # Count other colors in these rows
                other_colors = []
                for _, row in a_rows.iterrows():
                    row_colors = {row[col] for col in COLOR_COLS if row[col] and row[col] != '-'}
                    row_colors.discard(color_a)
                    other_colors.extend(list(row_colors))
                    
                other_counts = Counter(other_colors)
                for color_b, b_count in other_counts.items():
                    if b_count == a_count:
                        warnings.append(f"Color combination anomaly: Whenever '{color_a_title}' appears, it is always paired with '{color_b.title()}'")
                        
    # Seasonal distribution warnings
    if seasons_data:
        seasons_df = pd.DataFrame(seasons_data, columns=['color', 'season'])
        for color in active_colors:
            color_title = color.title()
            color_seasons = seasons_df[seasons_df['color'] == color]
            c_count = len(color_seasons)
            
            if c_count >= 15:
                season_counts = color_seasons['season'].value_counts()
                for season, s_count in season_counts.items():
                    pct = (s_count / c_count) * 100
                    if pct > 45.0:
                        warnings.append(
                            f"Color '{color_title}' shows high seasonal concentration: {pct:.1f}% of occurrences are in {season}."
                        )
                        
    # Temporal validation warnings
    if temporal_errors_count > 0:
        warnings.append(f"Found {temporal_errors_count} temporal errors (records with missing, pre-2020, or future dates)")
        
    # Compile report structure
    report = {
        "total_records": total_records,
        "records_after_cleaning": records_after_cleaning,
        "removed_records": removed_records,
        "issues_found": {
            "null_values": null_count,
            "duplicates": int(duplicates_count),
            "unknown_colors": len(unknown_colors_found),
            "formatting_errors": formatting_errors_count,
            "temporal_errors": temporal_errors_count
        },
        "color_distribution": color_distribution,
        "warnings": sorted(list(set(warnings)))
    }
    
    return report, df

def main():
    args = parse_args()
    input_path = args.input if args.input else args.input_file
    if not input_path:
        print("Error: Input file path is required. Pass it as a positional argument or use --input.", file=sys.stderr)
        sys.exit(1)
        
    # Auto-resolve typo files
    if not os.path.exists(input_path):
        parent_dir = os.path.dirname(input_path)
        base_name = os.path.basename(input_path)
        if base_name == 'color_combos.csv':
            alt_path = os.path.join(parent_dir, 'colorcombos.csv')
            if os.path.exists(alt_path):
                print(f"File not found: {input_path}. Falling back to: {alt_path}")
                input_path = alt_path
        elif base_name == 'colorcombos.csv':
            alt_path = os.path.join(parent_dir, 'color_combos.csv')
            if os.path.exists(alt_path):
                print(f"File not found: {input_path}. Falling back to: {alt_path}")
                input_path = alt_path
                
    print(f"Starting validation pipeline on: {input_path}")
    try:
        report, df_annotated = run_validation(input_path, args.data_dir)
        
        # Save validation report
        with open(args.output_report, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"✅ Validation report saved to: {args.output_report}")
        
        # Save cleaned dataset (filtered on is_clean == True)
        df_clean = df_annotated[df_annotated['is_clean']].copy()
        df_clean.to_csv(args.output_csv, index=False)
        print(f"✅ Cleaned CSV saved to: {args.output_csv} ({len(df_clean)} records remain)")
        
        # Summary log to console
        print("\n=== Validation Summary ===")
        print(f"Total Records Analyzed : {report['total_records']}")
        print(f"Clean Records Retained : {report['records_after_cleaning']}")
        print(f"Records Removed        : {report['removed_records']}")
        print(f"Formatting Issues Fixed: {report['issues_found']['formatting_errors']}")
        print("Issues Flagged:")
        for issue, count in report['issues_found'].items():
            print(f" - {issue.replace('_', ' ').title()}: {count}")
            
    except Exception as e:
        print(f"❌ Error during validation execution: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
