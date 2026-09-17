import pandas as pd

df = pd.read_csv('cleaned_predictions.csv')
df['target_color'] = df['top_outer_color'].where(df['top_outer_color'] != '-', df['predicted_top_outer_color'])
df['target_color'] = df['target_color'].astype(str).str.strip().str.lower()
df['year'] = pd.to_datetime(df['created_at'], errors='coerce').dt.year

print("Pre-2024 Target distribution (top 10):")
print(df[df['year'] < 2024]['target_color'].value_counts().head(10))

print("\n2024+ Target distribution (top 10):")
print(df[df['year'] >= 2024]['target_color'].value_counts().head(10))

print("\nPre-2024 unique target colors:", df[df['year'] < 2024]['target_color'].nunique())
print("2024+ unique target colors:", df[df['year'] >= 2024]['target_color'].nunique())

missing_colors_in_train = set(df[df['year'] >= 2024]['target_color'].unique()) - set(df[df['year'] < 2024]['target_color'].unique())
print("Colors in 2024+ not in pre-2024 train set:", missing_colors_in_train)
