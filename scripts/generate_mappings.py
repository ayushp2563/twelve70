import os
import json
import pandas as pd

# Define base directories
DATA_DIR = 'data'
colorshex_path = os.path.join(DATA_DIR, 'colorshex.csv')
colors_path = os.path.join(DATA_DIR, 'colors.csv')
patterns_dir = 'public/patterns'

# Load colors from files
colors = {}
if os.path.exists(colors_path):
    df_colors = pd.read_csv(colors_path)
    for _, row in df_colors.iterrows():
        name = str(row['name']).strip().lower()
        hexcode = str(row['hexcode']).strip()
        colors[name] = hexcode

if os.path.exists(colorshex_path):
    df_hex = pd.read_csv(colorshex_path)
    for _, row in df_hex.iterrows():
        name = str(row['name']).strip().lower()
        hexcode = str(row['hexcode']).strip()
        if name not in colors:
            colors[name] = hexcode


# Scan patterns dir
if os.path.exists(patterns_dir):
    for f in os.listdir(patterns_dir):
        if f.endswith('.png'):
            name = f[:-4].strip().lower()
            if name not in colors:
                # Assign a synthetic hex or default
                colors[name] = '#aaaaaa'

# Direct database slang/variants from colorcombos.csv
db_slang = {
    'bred': '#b20116', 
    'breds': '#b20116', 
    'royals': '#1748a2', 
    'coast': '#c2d4e3', 
    'syracuse': '#cc5500', 
    'st.johns': '#e40101', 
    'shadows': '#888888', 
    'photondust': '#e8e8e8', 
    'mediumcurry': '#b67525', 
    'laserorange': '#ff8800', 
    'royal-black': '#1748a2',
    'lightgrey-whitestripe': '#e8e8e8', 
    'black-greypolkadots': '#000000', 
    'black-yellowpolkadots': '#000000',
    'navy-blackpolkadots': '#0c1e32', 
    'green-whitepolkadots': '#39892f',
    '-': '#000000' # default for empty
}
for k, v in db_slang.items():
    if k not in colors:
        colors[k] = v

# Fallback for composite colors
df_combos = pd.read_csv(os.path.join(DATA_DIR, 'colorcombos.csv'))
cols = ['top_color', 'bottom_color', 'outerwear_color', 'footwear_color', 'top_outer_color']
all_combo_colors = set()
for col in cols:
    all_combo_colors.update(df_combos[col].dropna().unique())

for c in all_combo_colors:
    c_lower = c.strip().lower()
    if c_lower not in colors:
        # Check composite
        if '-' in c_lower:
            parts = c_lower.split('-')
            # Use hex of the first part
            first_part = parts[0]
            if first_part in colors:
                colors[c_lower] = colors[first_part]
            else:
                colors[c_lower] = '#888888'
        else:
            colors[c_lower] = '#888888'

# 1. Generate Family Mappings
def get_color_family(name):
    c = name.lower().replace('-', '').replace('_', '').replace(' ', '')
    pattern_keywords = [
        'camo', 'tartan', 'houndstooth', 'plaid', 'gingham', 'stripe', 
        'chalkstripe', 'polkadot', 'dots', 'leopard', 'herringbone', 'denim', 'marled'
    ]
    if any(kw in c for kw in pattern_keywords):
        return 'Pattern'
        
    family_map = {
        'black': 'Neutral', 'charcoal': 'Neutral', 'white': 'Neutral', 'offwhite': 'Neutral',
        'grey': 'Neutral', 'gray': 'Neutral', 'lightgrey': 'Neutral', 'slate': 'Neutral',
        'sand': 'Neutral', 'tan': 'Neutral', 'camel': 'Neutral', 'brown': 'Neutral',
        'tobacco': 'Neutral', 'vegtan': 'Neutral', 'shadows': 'Neutral', 'sail': 'Neutral',
        'photondust': 'Neutral', 'taupe': 'Neutral', 'warmgrey': 'Neutral', 'silver': 'Neutral',
        'red': 'Warm', 'burgundy': 'Warm', 'oxblood': 'Warm', 'maroon': 'Warm',
        'burntorange': 'Warm', 'orange': 'Warm', 'yellow': 'Warm', 'mustard': 'Warm',
        'rust': 'Warm', 'gold': 'Warm', 'bred': 'Warm', 'breds': 'Warm',
        'laserorange': 'Warm', 'coral': 'Warm',
        'blue': 'Cool', 'navy': 'Cool', 'royalblue': 'Cool', 'lightblue': 'Cool',
        'teal': 'Cool', 'turquoise': 'Cool', 'purple': 'Cool', 'deeppurple': 'Cool',
        'lavender': 'Cool', 'indigo': 'Cool', 'mint': 'Cool', 'violet': 'Cool',
        'mediumcurry': 'Cool', 'midnightblue': 'Cool', 'frenchblue': 'Cool',
        'olivegreen': 'Earth', 'green': 'Earth', 'forestgreen': 'Earth', 'khaki': 'Earth',
        'olive': 'Earth', 'sage': 'Earth',
        'lightpink': 'Pastel', 'dustypink': 'Pastel', 'hotpink': 'Pastel', 'pink': 'Pastel',
        'coast': 'Pastel'
    }
    
    if c in family_map:
        return family_map[c]
        
    for key, fam in family_map.items():
        if key in c or c in key:
            return fam
            
    if 'grey' in c or 'gray' in c or 'silver' in c:
        return 'Neutral'
    if 'blue' in c or 'navy' in c:
        return 'Cool'
    if 'green' in c or 'olive' in c:
        return 'Earth'
    if 'pink' in c or 'rose' in c:
        return 'Pastel'
    if 'red' in c or 'burg' in c or 'orange' in c:
        return 'Warm'
        
    return 'Neutral'

families = {}
for name in colors:
    families[name.title()] = get_color_family(name)

# 2. Generate Lightness Mappings
def hex_to_lightness(hexstr):
    if hexstr == '-':
        return 0.0
    hexstr = hexstr.lstrip('#')
    if len(hexstr) != 6:
        return 0.5
    try:
        r = int(hexstr[0:2], 16) / 255.0
        g = int(hexstr[2:4], 16) / 255.0
        b = int(hexstr[4:6], 16) / 255.0
        # HSL Lightness formula
        return round((max(r, g, b) + min(r, g, b)) / 2.0, 3)
    except:
        return 0.5

lightness = {}
for name, hexcode in colors.items():
    lightness[name.title()] = hex_to_lightness(hexcode)

# Save to workspace root
with open('color_families.json', 'w') as f:
    json.dump(families, f, indent=2, sort_keys=True)

with open('color_lightness.json', 'w') as f:
    json.dump(lightness, f, indent=2, sort_keys=True)

print("Generated mapping files successfully!")
print("Unique Colors Count:", len(colors))
