# Data Quality & Validation Pipeline for Outfit Colors

This pipeline provides structural, consistency, distribution, outlier, and temporal validations for Twelve70 outfit combinations. It ensures that data inputs remain clean, well-formatted, and accurate for recommendation engines and machine learning modeling.

---

## 🚀 How to Run the Validation

The validation pipeline runs as a standalone Python command line utility. It is configured to run inside the repository's virtual environment which contains all required dependencies (primarily `pandas` and `numpy`).

### Run Command

```bash
# Run on the standard outfit combinations file
./venv/bin/python3 validate_data.py --input data/colorcombos.csv

# Run on the outfit predictions file
./venv/bin/python3 validate_data.py --input data/colorcombos_with_predictions.csv \
  --output-report predictions_report.json \
  --output-csv cleaned_predictions.csv
```

### Script Arguments

- `--input` (Required): Path to the raw input CSV to validate (e.g. `data/colorcombos.csv`).
- `--output-report` (Optional): Target path for the output JSON quality report. (Default: `validation_report.json`).
- `--output-csv` (Optional): Target path to write the cleaned output CSV. (Default: `cleaned_outfits.csv`).
- `--data-dir` (Optional): Location of reference color and database configuration files (e.g., `colors.csv`). (Default: `data`).

---

## 🔍 Validation Checks Explained

The pipeline performs five major dimensions of validation:

### 1. Structural Validation
- **Column Integrity Check**: Confirms that all 5 color columns (`top_color`, `bottom_color`, `outerwear_color`, `footwear_color`, and `top_outer_color`) are present in the input file.
- **Null Value Detection**: Flags any row containing `NaN`, `None`, empty strings, or string representations of nulls (e.g. `'null'`, `'nan'`). 
  > [!NOTE]
  > The placeholder character `"-"` is treated as a valid value in the `top_outer_color` and `outerwear_color` positions because it represents the deliberate absence of that garment layer.
- **Duplicate Prevention**: Detects duplicate outfit records (same 5 colors repeated). The script retains only the first occurrence and flags subsequent rows as duplicates.
- **Formatting Standardization**: Standardizes all color values to lowercase and trims leading/trailing whitespaces. Rows that had different casings or extra whitespaces are flagged under `formatting_errors` and automatically corrected in the output cleaned file.

### 2. Color Consistency
- **Approved Colors Check**: Compares every color and pattern in the dataset against a reference set compiled from `data/colors.csv`, `data/colorshex.csv`, and all visual pattern texture assets inside `public/patterns/`.
- **Slang and Composite Recognition**: Safely approves recognized database terms (such as `bred`, `breds`, `royals`, `coast`, `syracuse`, `st.johns`, `shadows`, `photondust`, `mediumcurry`, `laserorange`) and composite sneaker colors (e.g. `white-orange` or `grey-black` where both parts are approved).
- **Unknown Colors Flagging**: Unrecognized colors (like typos `blavk` or wrong delimiters `navy_blue`) are flagged and removed from the clean dataset.

### 3. Data Distribution Check
- **Color Frequency Aggregation**: Counts color appearances across all columns to find popularity distribution.
- **Imbalance Identification**:
  - Flags **too common** colors (appearing in > 20% of all garment placements in the dataset).
  - Flags **too rare** colors (appearing in less than 10 combinations in total).
- **Combination Anomalies**: Identifies if a specific color is *always* paired with a single other color (e.g., if `'Mediumcurry'` shoes are only paired with `'Black'` trousers).

### 4. Outlier Detection
- **Duplicate Combination Count**: Flags outfits that appear only once in the entire dataset to detect potentially corrupt one-off data entry errors.
- **Position-Specific Omissions**: Analyzes if common colors (total count >= 10) never appear in certain garment slots (e.g. `Navy` never used as a `midlayer`).

### 5. Temporal Validation
- **Range & Validity Check**: Parses date fields (`created_at` or `updated_at`) and flags rows containing invalid date formats, future dates, or dates before 2020.
- **Seasonality Profiling**: Automatically maps dates to seasons:
  - **Winter**: Dec, Jan, Feb
  - **Spring**: Mar, Apr, May
  - **Summer**: Jun, Jul, Aug
  - **Fall**: Sep, Oct, Nov
- Flags colors showing disproportional seasonal concentration (e.g., if > 45% of its saves/purchases occur in a single season).

---

## 🛠️ How to Fix Common Issues

### Issue A: Typo / Unknown Color (e.g. `blavk`, `navy_blue`)
- **Reason**: The name does not exist in `colors.csv` or patterns.
- **Fix**: Correct the typo directly in the source data. Typo names must be replaced with the exact database term (e.g., `black`, `navy`).

### Issue B: Casing / Whitespace Formatting (e.g. `"Black "`, `"Navy"`)
- **Reason**: Casing and spaces do not match canonical lowercase formats.
- **Fix**: The pipeline **automatically resolves** this check by formatting them to lowercase and trimming spaces before writing the cleaned CSV. No manual intervention is required.

### Issue C: Invalid / Out-of-Range Dates
- **Reason**: Date column is blank, contains a placeholder date like `1970-01-01`, or a future date.
- **Fix**: Set valid dates or verify the ingestion script does not insert blank or system epoch dates.

---

## 📊 Threshold for "Acceptable" Data Quality

To ensure downstream systems (recommendation engines and ML trainers) do not degrade, the dataset must meet the following metrics:

| Metric | Target | Minimum Acceptable |
| :--- | :--- | :--- |
| **Overall Clean Record Rate** | **> 98%** | **95%** |
| **Null Value Frequency** | **0%** | **< 1%** |
| **Duplicate Outfit Rate** | **< 0.1%** | **< 1%** |
| **Unknown / Invalid Colors** | **0** | **< 0.5%** of rows |
| **Temporal Dates Validation** | **100% Valid** | **> 98%** |
