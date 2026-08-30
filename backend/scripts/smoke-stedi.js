// End-to-end smoke test for the Stedi sandbox integration: boots the server,
// seeds a provider profile if one isn't already configured, populates a
// synthetic claim, submits it to Stedi, and reports what came back.
//
// This automates the manual curl walkthrough in HANDOFF.md step 6 -- one
// command instead of two terminals and two hand-copied JSON blobs. It talks
// to Stedi's real sandbox network, so it needs STEDI_API_KEY set and a
// machine that can actually reach healthcare.us.stedi.com (a restrictive
// outbound proxy will surface as a network-level failure below, not a Stedi
// rejection -- the two are reported differently on purpose).
//
// Run: npm run smoke:stedi

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProviderProfile, upsertProviderProfile, DEFAULT_PROVIDER_ID } from "../src/providerProfiles.js";
import { DEMO_PROVIDER_PROFILE } from "./seed-provider-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "..");
// A dedicated port so this doesn't collide with a `npm run dev` you may
// already have open on 3000.
const PORT = process.env.SMOKE_PORT || 3202;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SAMPLE_ENCOUNTER = {
  facts: { chiefComplaint: "Sore throat" },
  codes: [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["J02.9"] },
  ],
};

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

if (!process.env.STEDI_API_KEY) {
  fail(
    "STEDI_API_KEY is not set. Add it to backend/.env (get a test-mode key from stedi.com/create-sandbox) and re-run."
  );
}

if (!getProviderProfile(DEFAULT_PROVIDER_ID)) {
  console.log(`No provider profile configured for '${DEFAULT_PROVIDER_ID}' -- seeding the demo profile.`);
  upsertProviderProfile(DEFAULT_PROVIDER_ID, DEMO_PROVIDER_PROFILE);
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not accepting connections yet -- keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy on ${BASE_URL} within ${timeoutMs}ms`);
}

console.log(`Starting server on port ${PORT}...`);
const server = spawn(process.execPath, ["src/server.js"], {
  cwd: BACKEND_DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

function stopServer() {
  if (!server.killed) server.kill();
}
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

try {
  await waitForHealth();
  console.log("Server is up.\n");

  console.log("[ 1/2 ] POST /api/populate-claim");
  const populateRes = await fetch(`${BASE_URL}/api/populate-claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(SAMPLE_ENCOUNTER),
  });
  const populateBody = await populateRes.json().catch(() => null);
  if (!populateRes.ok) {
    fail(`populate-claim returned HTTP ${populateRes.status}: ${JSON.stringify(populateBody)}`);
  }
  const { claim } = populateBody;
  console.log(`  ok -- claim built for provider NPI ${claim.provider?.npi}, ${claim.serviceLines.length} service line(s)`);
  if (claim.warnings?.length > 0) {
    console.log(`  warnings: ${claim.warnings.map((w) => w.code).join(", ")}`);
  }

  console.log("\n[ 2/2 ] POST /api/submit-claim (live call to Stedi's sandbox)");
  const submitRes = await fetch(`${BASE_URL}/api/submit-claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim }),
  });
  const submitBody = await submitRes.json().catch(() => null);

  if (submitRes.ok) {
    console.log("  ok -- Stedi accepted the submission.");
    console.log(`\nStedi response:\n${JSON.stringify(submitBody.stediResponse, null, 2)}`);
    console.log("\nPASS: claim built and accepted by Stedi's sandbox.");
    process.exit(0);
  }

  // submitToStedi.js sets `details` to Stedi's parsed JSON error body, or null
  // if the response body couldn't be parsed as JSON at all (e.g. a proxy's
  // plain-text 403 page instead of anything Stedi sent). Only a non-null
  // `details` means the request actually reached Stedi and Stedi said no --
  // `null` means it never got there.
  if (submitBody?.details != null) {
    console.error(`\nStedi rejected the submission (HTTP ${submitRes.status}):`);
    console.error(JSON.stringify(submitBody.details, null, 2));
    fail("Stedi rejected the claim -- see details above. This is a mapping/data problem, not a network problem.");
  }

  fail(
    `submit-claim returned HTTP ${submitRes.status} with no Stedi error body -- this usually means the request ` +
      `never reached Stedi (a firewall, proxy, or DNS block on healthcare.us.stedi.com). ` +
      `Response: ${JSON.stringify(submitBody)}`
  );
} catch (err) {
  console.error("\nServer output so far:\n" + serverOutput);
  fail(err.message);
}
