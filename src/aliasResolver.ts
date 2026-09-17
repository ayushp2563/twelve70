import fs from 'fs';
import path from 'path';

export class ColorAliasResolver {
  private idToName = new Map<string, string>();
  private aliases = new Map<string, string[]>(); // lowercase alias name -> lowercase parent names

  initialize(csvDir: string): void {
    const filePath = path.join(csvDir, 'data', 'colors.csv');
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  colors.csv not found at: ${filePath}`);
      return;
    }

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      
      // First pass: load ID to Name mapping
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(',');
        if (parts.length < 2) continue;
        const id = parts[0]?.trim();
        const name = parts[1]?.trim().toLowerCase();
        if (id && name) {
          this.idToName.set(id, name);
        }
      }

      // Second pass: load is_alias and alias_id mappings
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length < 6) continue;
        const name = parts[1]?.trim().toLowerCase();
        const isAlias = parts[3]?.trim() === '1';
        
        if (name && isAlias) {
          const targets: string[] = [];
          for (let colIdx = 4; colIdx <= 6; colIdx++) {
            const targetId = parts[colIdx]?.trim();
            if (targetId && targetId !== 'NULL' && targetId !== '' && this.idToName.has(targetId)) {
              targets.push(this.idToName.get(targetId)!);
            }
          }
          if (targets.length > 0) {
            this.aliases.set(name, targets);
          }
        }
      }
      console.log(`✅ ColorAliasResolver successfully loaded ${this.aliases.size} alias definitions.`);
    } catch (err) {
      console.error('❌ Failed to parse colors.csv in ColorAliasResolver:', err);
    }
  }

  /**
   * Resolves a color name to its active base color.
   * If the color has no combinations in the active colors set, it tries to resolve to its aliases.
   */
  resolve(colorName: string | undefined, activeColors: Set<string>): string {
    if (!colorName) return '';
    const normalized = colorName.toLowerCase().trim().replace(/\s+/g, '');
    
    // 1. If the color already exists with active combos, use it directly
    if (activeColors.has(normalized)) {
      return normalized;
    }

    // 2. Check colors.csv aliases
    const targets = this.aliases.get(normalized);
    if (targets && targets.length > 0) {
      for (const target of targets) {
        if (activeColors.has(target)) {
          return target;
        }
      }
      // If none of the targets are active, default to the first target
      return targets[0];
    }

    // 3. Fallback to basic string parsing (legacy alias logic)
    if (normalized.includes('offwhite') || normalized.includes('ivory') || normalized.includes('cream')) {
      if (activeColors.has('white')) return 'white';
      if (activeColors.has('offwhite')) return 'offwhite';
    }
    if (normalized.includes('charcoal') || normalized.includes('darkgrey')) {
      if (activeColors.has('charcoal')) return 'charcoal';
    }
    if (normalized.includes('navy') || normalized.includes('midnight')) {
      if (activeColors.has('navy')) return 'navy';
    }
    if (normalized.includes('burgundy') || normalized.includes('maroon')) {
      if (activeColors.has('burgundy')) return 'burgundy';
    }
    if (normalized.includes('olive') || normalized.includes('armygreen')) {
      if (activeColors.has('olive')) return 'olive';
      if (activeColors.has('olivegreen')) return 'olivegreen';
    }
    if (normalized.includes('tan') || normalized.includes('beige')) {
      if (activeColors.has('tan')) return 'tan';
    }

    // 4. Substring fallback to matching active colors
    for (const activeColor of activeColors) {
      if (normalized.includes(activeColor) || activeColor.includes(normalized)) {
        return activeColor;
      }
    }

    return normalized;
  }
}

export const colorAliasResolver = new ColorAliasResolver();
