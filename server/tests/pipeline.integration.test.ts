import { runClassificationPipeline } from "../src/analyzer/classification/pipeline.js";
import { classifyPage } from "../src/analyzer/classify.js";

async function runTests() {
  console.log("=== Running Pipeline Regression Integration Tests ===");

  const testCases = [
    {
      url: "https://inspiremedicalspas.com/refer-a-friend/",
      expectedCategory: "offers",
      expectedMethod: "denylist",
    },
    {
      url: "https://inspiremedicalspas.com/events/",
      expectedCategory: "events",
      expectedMethod: "denylist",
    },
    {
      url: "https://inspiremedicalspas.com/inspire-university/",
      expectedCategory: "education",
      expectedMethod: "denylist",
    },
    {
      url: "https://skinmedhealth.com/how-often-should-you-get-a-chemical-peel/",
      source: "post",
      expectedCategory: "blog",
      expectedMethod: "slug",
    },
    {
      url: "https://skinmedhealth.com/medical-grade-chemical-peels-in-chattanooga-tn/",
      source: "page",
      expectedCategory: "service",
      expectedMethod: "slug",
    }
  ];

  let passed = 0;
  for (const tc of testCases) {
    const path = new URL(tc.url).pathname;
    const source = tc.source || "page";
    const page = { url: tc.url, path, source, isPage: true } as any;
    const fast = classifyPage(path, source);
    const res = await runClassificationPipeline(page, "", "", fast);
    const pass = res.category === tc.expectedCategory && res.method === tc.expectedMethod;
    if (pass) passed++;
    console.log(`[${pass ? "PASS" : "FAIL"}] ${tc.url}`);
    console.log(`  Expected: ${tc.expectedCategory} via ${tc.expectedMethod}`);
    console.log(`  Actual:   ${res.category} via ${res.method} (score: ${res.confidence})`);
  }

  console.log(`\nTests passed: ${passed}/${testCases.length}`);
  if (passed !== testCases.length) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
