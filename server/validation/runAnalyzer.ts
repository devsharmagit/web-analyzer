// Runs the real analyzer against a site and returns its AnalyzeResult.
import { analyze, type AnalyzeResult } from "../src/analyzer/index.js";

export async function runAnalyzer(url: string): Promise<AnalyzeResult> {
  return analyze(url);
}
