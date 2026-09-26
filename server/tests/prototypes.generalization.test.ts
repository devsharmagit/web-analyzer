import fs from "fs";
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

import { embedText, cosineSimilarity } from "../src/analyzer/gemini.js";
import { PROTOTYPES } from "../src/analyzer/classification/prototypes.js";

async function runTests() {
  console.log("=== Testing Prototype Generalization Across Independent Clinics ===");

  const independentHubSamples = [
    {
      type: "skin",
      source: "Apex MedSpa (Independent)",
      text: "Skin Rejuvenation Treatments | Apex Med Spa. Achieve smoother, clearer skin with our medical-grade chemical peels, custom facials, and RF microneedling.",
      expectedCategory: "service"
    },
    {
      type: "skin",
      source: "Radiance Clinic (Independent)",
      text: "Clinical Skincare & Laser Treatments | Radiance Aesthetic Clinic. We provide advanced laser skin resurfacing, dermaplaning, and tailored facials.",
      expectedCategory: "service"
    },
    {
      type: "body",
      source: "Elite Medical Aesthetics (Independent)",
      text: "Body Sculpting & Contouring | Elite Medical Aesthetics. Non-invasive fat reduction, skin tightening, cellulite reduction, and spider vein laser therapy.",
      expectedCategory: "service"
    },
    {
      type: "body",
      source: "Pure Wellness Spa (Independent)",
      text: "Body Aesthetic Procedures | Pure Wellness Spa. Experience targeted body treatments, permanent laser hair reduction, and vascular vein treatments.",
      expectedCategory: "service"
    },
    {
      type: "medical",
      source: "Summit Aesthetics (Independent)",
      text: "Medical Dermatology & Clinical Services | Summit Aesthetics. Physician-led clinical visits, medical acne evaluations, and full skin exams.",
      expectedCategory: "service"
    },
    {
      type: "medical",
      source: "Beacon MedSpa (Independent)",
      text: "Clinical Medical Care | Beacon MedSpa. Comprehensive medical consultations, prescription acne treatments, and clinical dermatology visits.",
      expectedCategory: "service"
    }
  ];

  let passed = 0;
  for (const sample of independentHubSamples) {
    const vec = await embedText(sample.text);
    let best = null;
    let maxSim = -1;
    for (const p of PROTOTYPES) {
      if (!p.vector) continue;
      const sim = cosineSimilarity(vec, p.vector);
      if (sim > maxSim) {
        maxSim = sim;
        best = p;
      }
    }
    const isAboveThreshold = maxSim > 0.82;
    const isCategoryMatch = best?.category === sample.expectedCategory;
    const pass = isAboveThreshold && isCategoryMatch;
    if (pass) passed++;

    console.log(`[${pass ? "PASS" : "FAIL"}] ${sample.source} (${sample.type})`);
    console.log(`  Similarity: ${maxSim.toFixed(4)} | Category: ${best?.category}`);
  }

  console.log(`\nGeneralization tests passed: ${passed}/${independentHubSamples.length}`);
  if (passed !== independentHubSamples.length) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
