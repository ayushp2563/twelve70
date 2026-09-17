import pandas as pd
import os

def check():
    df_colors = pd.read_csv('data/colors.csv')
    df_combos = pd.read_csv('data/colorcombos.csv')
    
    # Map ID to Name
    id_to_name = {row['id']: str(row['name']).strip().lower() for _, row in df_colors.iterrows()}
    
    # Unique colors in combinations
    cols = ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color', 'top_outer_color']
    combo_colors = set()
    for col in cols:
         combo_colors.update(df_combos[col].dropna().astype(str).str.strip().str.lower().unique())
         
    print(f"Total colors in colors.csv: {len(df_colors)}")
    print(f"Total unique colors in colorcombos.csv: {len(combo_colors)}")
    
    # Analyze aliases
    aliases = df_colors[df_colors['is_alias'] == 1]
    print(f"\nFound {len(aliases)} alias colors in colors.csv:")
    print(f"{'Alias Name':<25} | {'In Combos?':<10} | {'Alias targets'}")
    print("-" * 70)
    for _, row in aliases.iterrows():
        name = str(row['name']).strip().lower()
        in_combos = "Yes" if name in combo_colors else "No"
        
        targets = []
        for target_col in ['alias_id', 'alias_id2', 'alias_id3']:
            target_id = row[target_col]
            if pd.notna(target_id) and target_id != 'NULL' and target_id in id_to_name:
                targets.append(id_to_name[target_id])
        
        print(f"{name:<25} | {in_combos:<10} | {', '.join(targets)}")

if __name__ == '__main__':
    check()
