const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Guards the shared event vocabulary: every name in the EVENTS registry must be
// documented, so founders and Claude Code never work from a stale list.
// Text-based on purpose — lib/analytics.ts imports posthog-js, which needs a browser.
const registry = fs.readFileSync(path.join(__dirname, "../lib/analytics.ts"), "utf8");
const doc = fs.readFileSync(path.join(__dirname, "../docs/ANALYTICS_EVENTS.md"), "utf8");

function registryEventNames() {
  const block = registry.match(/export const EVENTS = \{([\s\S]*?)\} as const;/);
  assert.ok(block, "EVENTS registry not found in lib/analytics.ts");
  return [...block[1].matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

test("every event name in the registry is documented", () => {
  const names = registryEventNames();
  assert.ok(names.length > 0, "no event names parsed from EVENTS");
  for (const name of names) {
    assert.ok(doc.includes(`\`${name}\``), `${name} is missing from docs/ANALYTICS_EVENTS.md`);
  }
});

test("documented events all exist in the registry", () => {
  const names = new Set(registryEventNames());
  const section = doc.match(/^## Events$([\s\S]*?)^## /m);
  assert.ok(section, "## Events section not found in the doc");
  const documented = [...section[1].matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(documented.length > 0, "no event rows parsed from the doc");
  for (const name of documented) {
    assert.ok(names.has(name), `${name} is documented but not in EVENTS`);
  }
});
