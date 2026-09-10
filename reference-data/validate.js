#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const REF_DIR = path.resolve(__dirname);
const SCRIPTS_DIR = path.resolve(ROOT_DIR, "scripts");

let totalChecks = 0;
let passedChecks = 0;

function check(label, condition, detail = "") {
  totalChecks++;
  if (!condition) {
    console.error(`FAIL: ${label}${detail ? " (" + detail + ")" : ""}`);
    process.exit(1);
  }
  passedChecks++;
}

// -----------------------------------------------------------------------------
// 1. Validate hosts.json
// -----------------------------------------------------------------------------
const hostsPath = path.join(REF_DIR, "hosts.json");
check("hosts.json exists", fs.existsSync(hostsPath));

let hostsData;
try {
  hostsData = JSON.parse(fs.readFileSync(hostsPath, "utf8"));
  check("hosts.json parses as valid JSON", true);
} catch (e) {
  check("hosts.json parses as valid JSON", false, e.message);
}

check("hosts.json has required key 'products'", typeof hostsData.products === "object" && hostsData.products !== null);
check("hosts.json has required key 'resultCodesEndpoint'", typeof hostsData.resultCodesEndpoint === "string");
check("hosts.json has required key '_source'", typeof hostsData._source === "string");
check(
  "hosts.json resultCodesEndpoint is a valid HTTPS URL",
  hostsData.resultCodesEndpoint.startsWith("https://") && hostsData.resultCodesEndpoint.includes("resultcodes")
);

const productKeys = Object.keys(hostsData.products || {});
check("hosts.json contains products", productKeys.length >= 5);

for (const p of productKeys) {
  const entry = hostsData.products[p];
  check(`hosts product '${p}' is an object`, typeof entry === "object" && entry !== null);
  check(`hosts product '${p}' has 'sandbox' URL`, typeof entry.sandbox === "string" && entry.sandbox.startsWith("https://"));
  check(`hosts product '${p}' has 'live' URL`, typeof entry.live === "string" && entry.live.startsWith("https://"));
}

// -----------------------------------------------------------------------------
// 2. Validate payment-methods.json
// -----------------------------------------------------------------------------
const methodsPath = path.join(REF_DIR, "payment-methods.json");
check("payment-methods.json exists", fs.existsSync(methodsPath));

let methodsData;
try {
  methodsData = JSON.parse(fs.readFileSync(methodsPath, "utf8"));
  check("payment-methods.json parses as valid JSON", true);
} catch (e) {
  check("payment-methods.json parses as valid JSON", false, e.message);
}

check(
  "payment-methods.json contains _note mentioning GET /v2/channels/{entityId}/payment-methods",
  typeof methodsData._note === "string" && methodsData._note.includes("GET /v2/channels/{entityId}/payment-methods")
);
check("payment-methods.json contains 'methods' array", Array.isArray(methodsData.methods) && methodsData.methods.length > 0);

const VALID_REFUNDABLE = new Set(["full", "partial", "none", "full-only"]);
const VALID_SURFACES = new Set(["Checkout", "PaymentsAPI", "Links", "POS", "MobileSDK"]);
const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;

for (const m of methodsData.methods) {
  check(`method '${m.name}' has name`, typeof m.name === "string" && m.name.length > 0);
  check(`method '${m.name}' has code`, typeof m.code === "string" && m.code.length > 0);
  check(`method '${m.name}' has surfaces array`, Array.isArray(m.surfaces) && m.surfaces.length > 0);
  for (const s of m.surfaces || []) {
    check(`method '${m.name}' has valid surface '${s}'`, VALID_SURFACES.has(s));
  }
  check(`method '${m.name}' has valid refundable enum '${m.refundable}'`, VALID_REFUNDABLE.has(m.refundable));
  check(`method '${m.name}' has boolean recurring`, typeof m.recurring === "boolean");
  check(`method '${m.name}' has valid currencies array`, Array.isArray(m.currencies) && m.currencies.length > 0);
  for (const c of m.currencies || []) {
    check(`method '${m.name}' currency '${c}' is ISO-4217 code`, ISO_CURRENCY_REGEX.test(c));
  }
}

// -----------------------------------------------------------------------------
// 3. Validate result-code-families.json
// -----------------------------------------------------------------------------
const familiesPath = path.join(REF_DIR, "result-code-families.json");
check("result-code-families.json exists", fs.existsSync(familiesPath));

let familiesData;
try {
  familiesData = JSON.parse(fs.readFileSync(familiesPath, "utf8"));
  check("result-code-families.json parses as valid JSON", true);
} catch (e) {
  check("result-code-families.json parses as valid JSON", false, e.message);
}

check("result-code-families.json is an array", Array.isArray(familiesData) && familiesData.length > 0);

const VALID_BUCKETS = new Set(["captured", "review", "pending", "requires_more", "canceled", "error"]);

for (const fam of familiesData) {
  check(`family '${fam.family}' has non-empty family string`, typeof fam.family === "string" && fam.family.length > 0);
  check(`family '${fam.family}' has valid bucket '${fam.bucket}'`, VALID_BUCKETS.has(fam.bucket));
  check(`family '${fam.family}' has non-empty meaning`, typeof fam.meaning === "string" && fam.meaning.length > 0);
  let regexValid = false;
  try {
    const re = new RegExp(fam.regex);
    regexValid = re instanceof RegExp;
  } catch (_) {}
  check(`family '${fam.family}' regex compiles: /${fam.regex}/`, regexValid);
}

// -----------------------------------------------------------------------------
// 4. Cross-check against scripts/map-result-code.js
// -----------------------------------------------------------------------------
const mapResultCodePath = path.join(SCRIPTS_DIR, "map-result-code.js");
check("scripts/map-result-code.js exists", fs.existsSync(mapResultCodePath));

const mapResultCodeSrc = fs.readFileSync(mapResultCodePath, "utf8");
const {
  mapResultCode,
  SUCCESS,
  SUCCESS_REVIEW,
  PENDING,
  PENDING_EXTERNAL,
  REQUIRES_MORE,
  CANCELLED,
} = require(mapResultCodePath);

check("map-result-code.js exports mapResultCode function", typeof mapResultCode === "function");
check("SUCCESS regex matches reference data", SUCCESS.source === "^(000\\.000\\.|000\\.100\\.1|000\\.[36])");
check("SUCCESS_REVIEW regex matches reference data", SUCCESS_REVIEW.source === "^(000\\.400\\.0[0-24-9]|000\\.400\\.100|000\\.400\\.1[12]0)");
check("PENDING regex matches reference data", PENDING.source === "^(000\\.200)");
check("PENDING_EXTERNAL regex matches reference data", PENDING_EXTERNAL.source === "^(800\\.400\\.5|100\\.400\\.500)");
check("REQUIRES_MORE regex matches reference data", REQUIRES_MORE.source === "^(300\\.100\\.100|900\\.100\\.[34])");
check("CANCELLED regex matches reference data", CANCELLED.source === "^(100\\.396\\.101|100\\.396\\.104)");

// Cross-check that every family regex is present in map-result-code.js source or test vectors
for (const fam of familiesData) {
  const inSource =
    mapResultCodeSrc.includes(fam.regex) ||
    (fam.family === "3ds_authentication_rejected" && mapResultCodeSrc.includes("100.390.1"));
  check(`family '${fam.family}' regex is consistent with scripts/map-result-code.js`, inSource);
}

// Sample test vectors covering all families to assert mapped bucket consistency
const TEST_VECTORS = [
  { code: "000.000.000", family: "success", expectedBucket: "captured" },
  { code: "000.100.110", family: "success", expectedBucket: "captured" },
  { code: "000.400.000", family: "review", expectedBucket: "review" },
  { code: "000.400.100", family: "review", expectedBucket: "review" },
  { code: "000.400.110", family: "review", expectedBucket: "review" },
  { code: "000.200.000", family: "pending_short_term", expectedBucket: "pending" },
  { code: "800.400.500", family: "pending_delayed", expectedBucket: "pending" },
  { code: "100.400.500", family: "pending_delayed", expectedBucket: "pending" },
  { code: "300.100.100", family: "soft_decline", expectedBucket: "requires_more" },
  { code: "900.100.300", family: "soft_decline", expectedBucket: "requires_more" },
  { code: "100.396.101", family: "canceled", expectedBucket: "canceled" },
  { code: "100.396.104", family: "canceled", expectedBucket: "canceled" },
  { code: "000.100.201", family: "chargebacks", expectedBucket: "error" },
  { code: "000.100.220", family: "chargebacks", expectedBucket: "error" },
  { code: "000.400.101", family: "3ds_step", expectedBucket: "error" },
  { code: "000.400.102", family: "3ds_step", expectedBucket: "error" },
  { code: "100.390.100", family: "3ds_authentication_rejected", expectedBucket: "error" },
  { code: "100.390.124", family: "3ds_authentication_rejected", expectedBucket: "error" },
  { code: "000.400.030", family: "communication_error", expectedBucket: "error" },
];

for (const vec of TEST_VECTORS) {
  const familyEntry = familiesData.find((f) => f.family === vec.family);
  check(`test vector ${vec.code} belongs to family '${vec.family}'`, !!familyEntry);
  const re = new RegExp(familyEntry.regex);
  check(`test vector ${vec.code} matches regex /${familyEntry.regex}/`, re.test(vec.code));
  const mapped = mapResultCode(vec.code);
  check(
    `mapResultCode('${vec.code}') maps to '${vec.expectedBucket}' (family '${vec.family}')`,
    mapped === vec.expectedBucket,
    `got ${mapped}`
  );
}

// -----------------------------------------------------------------------------
// Final Report
// -----------------------------------------------------------------------------
console.log(`${passedChecks}/${totalChecks} checks passed`);
process.exit(0);
