interface CacheEntry {
  data: any;
  timestamp: number;
}
 
class ColorMatchCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly TTL = 60 * 60 * 1000; // 1 hour
 
  generateKey(outfit: any): string {
    return `${outfit.topColor}:${outfit.bottomColor}:${outfit.outerwearColor}:${outfit.footwearColor}`;
  }
 
  get(outfit: any): any | null {
    const key = this.generateKey(outfit);
    const entry = this.cache.get(key);
 
    if (!entry) return null;
 
    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(key);
      return null;
    }
 
    return entry.data;
  }
 
  set(outfit: any, data: any): void {
    const key = this.generateKey(outfit);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
 
    // Keep cache size manageable
    if (this.cache.size > 10000) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }
 
  clear(): void {
    this.cache.clear();
  }
}
 
export const colorCache = new ColorMatchCache();