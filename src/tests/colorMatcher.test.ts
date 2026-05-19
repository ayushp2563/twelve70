import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { matchTopOuterColor, OutfitInput } from '../colorMatcher';
import mysql, { Connection } from 'mysql2/promise';

describe('Color Matching Algorithm', () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection({
      host: 'localhost',
      port: 3307,
      user: 'myuser',
      password: 'mypass',
      database: 'mydb'
    });
  });

  afterAll(async () => {
    await connection.end();
  });

  test('should match black outfit', async () => {
    const outfit: OutfitInput = {
      topColor: 'black',
      bottomColor: 'black',
      outerwearColor: 'black',
      footwearColor: 'white'
    };

    const result = await matchTopOuterColor(outfit, connection);

    expect(result.primary).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test('should handle off-white using alias logic', async () => {
    const outfit: OutfitInput = {
      topColor: 'off white', // Should be resolved to 'white'
      bottomColor: 'black',
      outerwearColor: 'black',
      footwearColor: 'black'
    };

    const result = await matchTopOuterColor(outfit, connection);

    expect(result.matchType).toBe('family'); 
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  test('should return family match for navy outfit', async () => {
    const outfit: OutfitInput = {
      topColor: 'white',
      bottomColor: 'navy',
      outerwearColor: 'navy',
      footwearColor: 'black'
    };

    const result = await matchTopOuterColor(outfit, connection);

    expect(result.matchType).toBe('family');
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  test('should handle unknown colors gracefully', async () => {
    const outfit: OutfitInput = {
      topColor: 'super_strange_color',
      bottomColor: 'black',
      outerwearColor: 'black',
      footwearColor: 'white'
    };

    const result = await matchTopOuterColor(outfit, connection);

    expect(result.primary).toBeDefined();
    expect(['exact', 'family', 'frequency']).toContain(result.matchType);
  });
});