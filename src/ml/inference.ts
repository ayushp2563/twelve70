/**
 * ============================================================================
 * ONNX INFERENCE ENGINE & RE-RANKER
 * ============================================================================
 *
 * Purpose : Executes ultra-low-latency model inference inside Express.
 *           Loads XGBoost/LightGBM model (serialized to .onnx), runs batch
 *           tensor calculations on retrieved candidates, and computes hybrid
 *           recommendation ranks.
 *
 * Resilience: If the model file is not found, it runs in safe fallback mode.
 * ============================================================================
 */

import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { ColorOption, engine } from '../sequentialFilter';
import { extractCandidateFeatureArray, FeatureExtractionContext } from './featureExtractor';

export class MLReRankingEngine {
  private session: ort.InferenceSession | null = null;
  private modelPath: string;
  private isModelAvailable = false;

  constructor() {
    this.modelPath = path.join(process.cwd(), 'models', 'outfit_ranker.onnx');
  }

  /**
   * Initializes the ONNX Runtime session in-memory
   */
  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.modelPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.modelPath)) {
        console.warn(`\n⚠️  ML Re-Ranker model 'models/outfit_ranker.onnx' not found.`);
        console.warn(`   Server will start in safe fallback mode (graph-only ranking).`);
        console.warn(`   To enable ML, train the pipeline and save the ONNX file inside: ${this.modelPath}\n`);
        this.isModelAvailable = false;
        return;
      }

      // Reject placeholder/mock files: a real ONNX file is a binary protobuf,
      // while the training pipeline's legacy failure path wrote a plain-text
      // 'MOCK_ONNX_MODEL_FILE' marker. Loading that would crash or, worse,
      // produce garbage rankings.
      const header = Buffer.alloc(20);
      const fd = fs.openSync(this.modelPath, 'r');
      fs.readSync(fd, header, 0, 20, 0);
      fs.closeSync(fd);
      if (header.toString('utf8').startsWith('MOCK_ONNX_MODEL_FILE')) {
        console.warn(`\n⚠️  ${this.modelPath} is a mock placeholder, not a trained model.`);
        console.warn(`   Server will start in safe fallback mode (graph-only ranking).`);
        console.warn(`   Run 'python ml_pipeline/train.py' with ML libraries installed to produce a real model.\n`);
        this.isModelAvailable = false;
        return;
      }

      // Load ONNX Session
      this.session = await ort.InferenceSession.create(this.modelPath);
      this.isModelAvailable = true;
      console.log('✅ Machine Learning Re-Ranking Engine (LightGBM/ONNX) successfully initialized.');
    } catch (err) {
      console.error('❌ Failed to initialize ONNX Runtime session:', err);
      this.isModelAvailable = false;
    }
  }

  /**
   * Checks if the ML ranking model is loaded and ready
   */
  isEnabled(): boolean {
    return this.isModelAvailable && this.session !== null;
  }

  /**
   * Dynamically re-ranks candidates using LightGBM model utilities
   */
  async reRankCandidates(
    candidates: ColorOption[],
    ctx: FeatureExtractionContext,
    targetSlot: string
  ): Promise<ColorOption[]> {
    // 1. Fallback if model is not loaded
    if (!this.isEnabled() || !this.session || candidates.length === 0) {
      return candidates;
    }

    const resolvedCtx: FeatureExtractionContext = {
      ...ctx,
      topColor: ctx.topColor ? engine.resolveColor(ctx.topColor) : undefined,
      bottomColor: ctx.bottomColor ? engine.resolveColor(ctx.bottomColor) : undefined,
      outerwearColor: ctx.outerwearColor ? engine.resolveColor(ctx.outerwearColor) : undefined,
      footwearColor: ctx.footwearColor ? engine.resolveColor(ctx.footwearColor) : undefined,
      topOuterColor: ctx.topOuterColor ? engine.resolveColor(ctx.topOuterColor) : undefined,
    };

    const batchSize = candidates.length;
    const featureDim = 9; // Flat features in featureExtractor
    const floatArray = new Float32Array(batchSize * featureDim);

    // 2. Hydrate flat batch tensor array
    for (let i = 0; i < batchSize; i++) {
      const cand = candidates[i];
      const features = extractCandidateFeatureArray(cand, resolvedCtx, targetSlot);
      
      const offset = i * featureDim;
      for (let f = 0; f < featureDim; f++) {
        floatArray[offset + f] = features[f];
      }
    }

    try {
      // 3. Bind ONNX Input Tensors
      const tensor = new ort.Tensor('float32', floatArray, [batchSize, featureDim]);
      const feeds: Record<string, ort.Tensor> = { input: tensor };

      // 4. Run inference
      const output = await this.session.run(feeds);
      
      // LightGBM ONNX outputs raw utility scores in the 'variable' or 'output' node
      const outputNodeName = Object.keys(output)[0] || 'variable';
      const rawScores = output[outputNodeName].data as Float32Array;

      // 5. MinMax Normalization over the batch to map to 0-100 style utility scale
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < rawScores.length; i++) {
        if (rawScores[i] < min) min = rawScores[i];
        if (rawScores[i] > max) max = rawScores[i];
      }

      // Confidence gate: if the model barely separates the candidates, its
      // ranking signal is noise. Normalizing a near-flat score range would
      // amplify that noise into large score differences, so instead keep the
      // rule-engine (retrieval) order untouched.
      const MIN_SCORE_SPREAD = 1e-3;
      if (!isFinite(min) || !isFinite(max) || max - min < MIN_SCORE_SPREAD) {
        return candidates;
      }

      const reRanked: ColorOption[] = [];
      for (let i = 0; i < batchSize; i++) {
        const candidate = candidates[i];
        const rawVal = rawScores[i];
        
        // Scale normalized value (handles edge case where min == max)
        const mlUtil = max === min ? 50 : ((rawVal - min) / (max - min)) * 100;
        
        // Hybrid Blend: 40% pure graph aesthetic score, 60% ML ranking popularity utility
        const hybridScore = Math.round(candidate.score * 0.4 + mlUtil * 0.6);

        reRanked.push({
          ...candidate,
          score: hybridScore,
          reasons: [
            ...candidate.reasons,
            `ML Rank Optimizer (Affinity Utility: ${mlUtil.toFixed(0)}pts)`
          ]
        });
      }

      // Sort by the new hybrid score (highest first)
      return reRanked.sort((a, b) => b.score - a.score || b.frequency - a.frequency);
    } catch (err) {
      console.error('❌ ONNX Re-ranking inference failed, falling back to retrieval order:', err);
      return candidates;
    }
  }
}

export const mlRanker = new MLReRankingEngine();
