# Color Mappings and Color Theory Reasoning

This document details the classification and lightness mappings for the 107+ colors and patterns in the Twelve70 wardrobe system.

---

## 🎨 Color Family Classification & Reasoning

Each color is classified into one of six core families to help models learn structural styling rules:

### 1. Neutral Family
- **Included Colors**: Black, Charcoal, Grey, Light Grey, Cool Grey, Warm Grey, Moonrock, White, Off-white, Sail, Sand, Tan, Camel, Taupe, Shadows, Brown, Dark Brown, Tobacco, Vegtan, Obsidian Black, Pirate Black, Nickel Grey, Oxford Tan, Turtledove, Paris Olympics.
- **Styling Reasoning**: Neutrals have no dominant hue and serve as the structural anchor of any outfit. They have high visual flexibility and pair harmoniously with all other color families. They are classified as neutrals to allow the model to learn the "Neutral Base Rule" (using at least one neutral layer to ground vibrant colors).

### 2. Warm Family
- **Included Colors**: Red, Jolly Red, Burgundy, Maroon, Oxblood, Orange, Burnt Orange, Laser Orange, Coral, Yellow, Light Yellow, Mustard, Gold, Rust, Bred, Breds.
- **Styling Reasoning**: These colors contain dominant red, orange, or yellow wavelengths. Warm colors have high visual weight and draw immediate focus. They are classified as Warm to enforce clash prevention with Pastels and other conflicting warm groups.

### 3. Cool Family
- **Included Colors**: Blue, Royal Blue, French Blue, Midnight Blue, Navy, Light Blue, Teal, Turquoise, Purple, Deep Purple, Lavender, Indigo, Mint, Violet, Medium Curry.
- **Styling Reasoning**: These colors contain dominant blue, green-blue, or purple wavelengths. They project coolness and visual calm. Navy is classified here as a styling Cool (acting as a versatile anchor), and others are grouped to check compatibility with earth and warm tones.

### 4. Earth Family
- **Included Colors**: Green, Forest Green, Olive Green, Khaki, Olive, Sage, Frankengreen.
- **Styling Reasoning**: These colors mimic organic foliage and forest shades (greens, muted sage, muddy khakis). They carry a rustic vibe and coordinate particularly well with warm browns and neutrals.

### 5. Pastel Family
- **Included Colors**: Pink, Dusty Pink, Light Pink, Hot Pink, Coast.
- **Styling Reasoning**: Highly desaturated, high-value colors (primarily pinks and soft blues/creams). They are grouped to ensure the model flags "Pastel-Neon Clashes" where highly saturated neons compete visually with soft pastels.

### 6. Pattern Family
- **Included Colors**: Camo, Tartan, Houndstooth, Plaid, Gingham, Stripe, Chalkstripe, Polkadot, Dots, Leopard, Herringbone, Denim, Marled textures, and all composite patterns (e.g. `green-blackbuffaloplaid`, `charcoal-whitechalkstripe`).
- **Styling Reasoning**: Garments containing multi-color prints, stripes, or fabric weaves. They are grouped in Pattern to enforce the "Pattern Isolation Rule" which restricts outfits from stacking multiple busy prints to prevent chaotic visual noise.

---

## 💡 Lightness Mapping & Consistency Check

Lightness is represented as a normalized decimal `[0.0, 1.0]` where:
- `0.0` $\rightarrow$ Pitch Black / Total Darkness
- `0.5` $\rightarrow$ Mid-tone Gray / Medium Saturation
- `1.0` $\rightarrow$ Pure White / Total Luminance

### Consistency Analysis

1. **Darks (0.0 - 0.25)**:
   - `Black` (0.0), `Charcoal` (0.30), `Navy` (0.12), `Dark Brown` (0.11), `Deep Purple` (0.19), `Forest Green` (0.18).
   - *Consistency check*: All dark colors are grouped in the low range, matching visual expectations. 

2. **Medium Tones (0.26 - 0.70)**:
   - `Camel` (0.64), `Tan` (0.59), `Sage` (0.61), `Mustard` (0.43), `Burnt Orange` (0.40), `Light Pink` (0.81), `Dusty Pink` (0.64).
   - *Consistency check*: Medium saturations hover near the center, preserving styling contrast ranges.

3. **Lights (0.71 - 1.0)**:
   - `White` (1.0), `Off-white` (0.94), `Sail` (0.93), `Light Grey` (0.91), `Lavender` (0.91), `Sand` (0.83).
   - *Consistency check*: Highly reflective shades reside at the top of the scale, allowing models to detect high-contrast layering patterns (like light top under a dark jacket).

4. **Patterns (0.667)**:
   - Pattern combinations with white or light accents default to a blended `0.667` to represent their multi-tonal nature, unless their base color dominates.

---

## 📁 Shared Mappings File

The consolidated mapping file is saved at **[color_mappings.json](file:///Users/ayush/Coding/twelve70/color_mappings.json)** for easy ingestion by freelancers, engineering teams, or ML engines.
