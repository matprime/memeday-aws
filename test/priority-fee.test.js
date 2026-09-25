const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_PATH = path.join(__dirname, "..", "lib", "solana", "priority-fee.ts");

async function load() {
  return import(pathToFileURL(MODULE_PATH).href);
}

const fees = (...xs) => xs.map((prioritizationFee) => ({ prioritizationFee }));

test("priority fee: no samples, or only zeros, gives the floor", async () => {
  const { choosePriorityFee, MIN_PRIORITY_MICROLAMPORTS } = await load();
  assert.equal(choosePriorityFee([]), MIN_PRIORITY_MICROLAMPORTS);
  assert.equal(choosePriorityFee(fees(0, 0, 0)), MIN_PRIORITY_MICROLAMPORTS);
});

test("priority fee: the median of the non-zero samples is used", async () => {
  const { choosePriorityFee } = await load();
  assert.equal(choosePriorityFee(fees(0, 0, 5_000, 9_000, 7_000)), 7_000);
  // A single outlier does not drag the price the way an average would.
  assert.equal(choosePriorityFee(fees(4_000, 4_000, 4_000, 40_000)), 4_000);
});

test("priority fee: the result is clamped to the floor and the hard cap", async () => {
  const { choosePriorityFee, MIN_PRIORITY_MICROLAMPORTS, MAX_PRIORITY_MICROLAMPORTS } = await load();
  assert.equal(choosePriorityFee(fees(5)), MIN_PRIORITY_MICROLAMPORTS);
  assert.equal(choosePriorityFee(fees(9_000_000, 9_000_000)), MAX_PRIORITY_MICROLAMPORTS);
});

test("priority fee: malformed samples are ignored", async () => {
  const { choosePriorityFee, MIN_PRIORITY_MICROLAMPORTS } = await load();
  assert.equal(choosePriorityFee(fees(NaN, Infinity, -5)), MIN_PRIORITY_MICROLAMPORTS);
});

test("priority fee: worst case cost stays within 10,000 lamports", async () => {
  const { MAX_PRIORITY_MICROLAMPORTS, MINT_COMPUTE_UNIT_LIMIT } = await load();
  assert.ok((MAX_PRIORITY_MICROLAMPORTS * MINT_COMPUTE_UNIT_LIMIT) / 1e6 <= 10_000);
});

test("priority fee: compute budget instructions are encoded as the runtime expects", async () => {
  const { computeBudgetInstructions, MINT_COMPUTE_UNIT_LIMIT } = await load();
  const [limit, price] = computeBudgetInstructions(12_345);

  // SetComputeUnitLimit: tag 2, u32 little-endian.
  assert.deepEqual(
    [...limit.instruction.data],
    [2, ...new Uint8Array(new Uint32Array([MINT_COMPUTE_UNIT_LIMIT]).buffer)]
  );
  // SetComputeUnitPrice: tag 3, u64 little-endian (12345 = 0x3039).
  assert.deepEqual([...price.instruction.data], [3, 0x39, 0x30, 0, 0, 0, 0, 0, 0]);

  for (const ix of [limit, price]) {
    assert.equal(String(ix.instruction.programId), "ComputeBudget111111111111111111111111111111");
    assert.deepEqual(ix.instruction.keys, []);
    assert.deepEqual(ix.signers, []);
  }
});

test("priority fee: a price above the cap is refused rather than built", async () => {
  const { computeBudgetInstructions, MAX_PRIORITY_MICROLAMPORTS } = await load();
  assert.doesNotThrow(() => computeBudgetInstructions(MAX_PRIORITY_MICROLAMPORTS));
  assert.throws(() => computeBudgetInstructions(MAX_PRIORITY_MICROLAMPORTS + 1), /out of bounds/);
  assert.throws(() => computeBudgetInstructions(-1), /out of bounds/);
  assert.throws(() => computeBudgetInstructions(1.5), /out of bounds/);
  assert.throws(() => computeBudgetInstructions(NaN), /out of bounds/);
});
