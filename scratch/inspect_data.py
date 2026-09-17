import pandas as pd

df = pd.read_csv('cleaned_predictions.csv')
df['year'] = pd.to_datetime(df['created_at'], errors='coerce').dt.year

print("Pre-2024:")
pre_2024 = df[df['year'] < 2024]
print(f"Total rows: {len(pre_2024)}")
print(f"Actual top_outer_color != '-': {(pre_2024['top_outer_color'] != '-').sum()}")
print(f"Predicted top_outer_color: {(pre_2024['top_outer_color'] == '-').sum()}")

print("\n2024+:")
post_2024 = df[df['year'] >= 2024]
print(f"Total rows: {len(post_2024)}")
print(f"Actual top_outer_color != '-': {(post_2024['top_outer_color'] != '-').sum()}")
print(f"Predicted top_outer_color: {(post_2024['top_outer_color'] == '-').sum()}")
