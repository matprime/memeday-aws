// KAN-67: find (and, with --apply, delete) orphan points/leaderboard rows in
// MemeDayDev -- rows whose userId has no USER# item. These come from
// scripts/test-s3-upload-handler.sh's integration run (`test-user-<epoch>`,
// see .github/workflows/ci.yml's "Integration test - S3 handler (dev stack)"
// step): it writes a MEME# item directly to race the deployed StreamHandler,
// which then awards that fake creatorId real UPLOAD points
// (lambdas/stream-handler/index.ts:806-831) with no Cognito user behind it.
// KAN-101's leaderboard read (lib/db.ts getPointsLeaderboardRows) already
// filters these out at read time; this is the follow-up that actually
// removes them.
//
// Usage (dotenv-cli lives in infra/, same convention as
// scripts/test-s3-upload-handler.sh):
//   cd infra && npx dotenv -e ../.env -- node ../scripts/cleanup-orphan-points.ts
//
// Dry run (default): reports orphans, writes every key that WOULD be deleted
// to a JSON file outside the repo (os.tmpdir()), deletes nothing.
//
// Apply (separate, explicit step -- re-reads a dry-run file, does not
// re-discover):
//   cd infra && npx dotenv -e ../.env -- node ../scripts/cleanup-orphan-points.ts --apply /tmp/orphan-points-<ts>.json

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  BatchGetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { utcDateKey, isoWeekKey } from "../lib/points-config.ts";

// ---------------------------------------------------------------------------
// Table guard. This script deletes data (in --apply mode) and must never be
// pointed at MemeDayProd. The table name is a literal below, not read from
// any env var or CLI flag, so there is no input that could override it --
// assertRequiredTable exists to make that guarantee explicit and testable,
// not because the literal could actually be anything else at runtime.
// ---------------------------------------------------------------------------
export const REQUIRED_TABLE = "MemeDayDev";

export function assertRequiredTable(name: string): void {
  if (name !== REQUIRED_TABLE) {
    throw new Error(
      `Refusing to run against table "${name}": this script only ever operates on "${REQUIRED_TABLE}".`
    );
  }
}
assertRequiredTable(REQUIRED_TABLE);
const TABLE = REQUIRED_TABLE;

// ---------------------------------------------------------------------------
// Test-pattern classification. `grep -rnoE '(userId|creatorId|likerId|commenterId|referrerId|earnerId)\s*=\s*`[^$]*\$\{' test/*.test.js`
// plus a second pass for ids passed inline rather than assigned to a
// variable (`grep -rnoE '`[a-zA-Z][a-zA-Z0-9_-]*-\$\{Date\.now\(\)' test/*.test.js`)
// turns up every fake-id template literal in test/. They fall into exactly
// three shapes, all confirmed against live source, not guessed:
//   - "test-...-" (hyphens): test/pending-upload.test.js, test/mint-request.test.js,
//     test/browse-feed-page.test.js, test/report.test.js, and others, plus
//     scripts/test-s3-upload-handler.sh's `USER="test-user-$(date +%s)"` --
//     the only script that races the deployed StreamHandler against
//     MemeDayDev outside `npm test` itself (.github/workflows/ci.yml).
//   - "test_...-" (underscores): test/points.test.js, test/stream-handler.test.js,
//     test/comment-creation.test.js, test/voting-enforcement.test.js. These
//     run as real integration tests against the live table too -- ci.yml's
//     "Run unit tests" step injects DYNAMODB_TABLE_NAME and runs `npm test`
//     (node --test) directly against MemeDayDev, not only the S3 handler
//     shell script.
//   - "someone-else-": test/bags-token-binding.test.js:248,
//     test/meme-listing.test.js:147 -- a second fixture creator, same
//     Date.now()-suffixed shape as the others.
// A real Cognito sub is never any of these three shapes, so all three are
// safe to use for deletion, not just reporting.
// ---------------------------------------------------------------------------
const TEST_USER_PREFIXES = ["test-", "test_", "someone-else-"];

export type OrphanClassification = "test-pattern" | "other";

export function classifyUserId(userId: string): OrphanClassification {
  return TEST_USER_PREFIXES.some((prefix) => userId.startsWith(prefix))
    ? "test-pattern"
    : "other";
}

// ---------------------------------------------------------------------------
// AWS client
// ---------------------------------------------------------------------------
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Discovery (no Scan -- the runtime IAM user has none, and this script
// mirrors that constraint even though the credentials it actually runs under
// today may be broader).
// ---------------------------------------------------------------------------

interface RawItem {
  PK: string;
  SK: string;
  [key: string]: unknown;
}

// Fully paginated GSI3 query for one GSI3PK value (LB#ALLTIME, LB#WEEK#<key>,
// or LB#DAY#<key> -- all three live on GSI3, see docs/ARCHITECTURE.md's GSI
// table).
async function queryGsi3All(gsi3pk: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI3",
        KeyConditionExpression: "GSI3PK = :pk",
        ExpressionAttributeValues: { ":pk": gsi3pk },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as RawItem[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

// Fully paginated base-table query for one user's points ledger: AWARD#
// rows, DAY# daily counters, and the REFERREDBY marker (all PK=POINTS#<id>).
async function queryLedger(userId: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `POINTS#${userId}` },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as RawItem[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

// BatchGetItem caps out at 100 keys per call and can return a partial result
// under UnprocessedKeys (throttling) -- same chunk+retry shape as
// lib/db.ts's getUsersByIds/batchGetAll and lambdas' own conventions. Returns
// the subset of userIds that DO have a USER# item.
async function findExistingUserIds(userIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < userIds.length; i += 100) {
    let keys: { PK: string; SK: string }[] = userIds
      .slice(i, i + 100)
      .map((id) => ({ PK: `USER#${id}`, SK: `USER#${id}` }));
    while (keys.length > 0) {
      const result = await client.send(
        new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } })
      );
      for (const item of result.Responses?.[TABLE] ?? []) {
        found.add((item as Record<string, unknown>).userId as string);
      }
      const unprocessed = result.UnprocessedKeys?.[TABLE]?.Keys as
        | { PK: string; SK: string }[]
        | undefined;
      keys = unprocessed ?? [];
      if (keys.length > 0) await sleep(50);
    }
  }
  return found;
}

function userIdFromLbItem(item: RawItem): string {
  return (item.userId as string | undefined) ?? (item.SK as string).slice("USER#".length);
}

export interface DeleteKey {
  PK: string;
  SK: string;
  itemType: "LB#ALLTIME" | "LB#WEEK#" | "LB#DAY#" | "AWARD#" | "DAY#" | "REFERREDBY";
}

export interface OrphanRecord {
  userId: string;
  foundVia: "GSI3-ALLTIME" | "secondary-sweep";
  classification: OrphanClassification;
  weekKeys: string[];
  dayKeys: string[];
  keys: DeleteKey[];
}

// Builds the full delete-key set for one orphan: the raw LB# row it was
// discovered under (already known, no extra read), every AWARD#/DAY#/
// REFERREDBY row under its ledger, and every LB#WEEK#/LB#DAY# row its ledger
// touches.
//
// Week/day derivation, verified against lambdas/stream-handler/index.ts:
//   - awardPoints (lines 208-322) buckets by the SOURCE item's createdAt,
//     never processing time: `const sourceDate = new Date(params.createdAt)`
//     (line 217), then `dayKey = utcDateKey(sourceDate)` /
//     `weekKey = isoWeekKey(sourceDate)` (lines 218-219).
//   - The award ledger row stores that week directly: `week: weekKey` on the
//     awardItem (line 228) -- so weekKeys can be read straight off each
//     AWARD# row instead of recomputing them.
//   - The daily counter's own SK embeds the day: `DAY#${dayKey}#${action}`
//     (line 247) -- so dayKeys come from the DAY# rows' SKs.
//   - Every award is one TransactWriteItems touching the day counter, the
//     LB#DAY#, LB#WEEK#, and LB#ALLTIME rows together (lines 236-297), so an
//     LB#ALLTIME row always exists once any AWARD# exists. It is still
//     re-fetched with a GetItem rather than assumed, so an orphan with a
//     hand-seeded LB# row and no ledger (no award to hang that guarantee on)
//     doesn't get a fabricated delete key.
async function collectOrphanKeys(
  userId: string,
  discoveredVia: RawItem
): Promise<{ keys: DeleteKey[]; weekKeys: string[]; dayKeys: string[] }> {
  const seen = new Set<string>();
  const keys: DeleteKey[] = [];
  function add(pk: string, sk: string, itemType: DeleteKey["itemType"]): void {
    const dedupeId = `${pk}#${sk}`;
    if (seen.has(dedupeId)) return;
    seen.add(dedupeId);
    keys.push({ PK: pk, SK: sk, itemType });
  }

  const discoveredItemType: DeleteKey["itemType"] = discoveredVia.PK.startsWith("LB#WEEK#")
    ? "LB#WEEK#"
    : discoveredVia.PK.startsWith("LB#DAY#")
      ? "LB#DAY#"
      : "LB#ALLTIME";
  add(discoveredVia.PK, discoveredVia.SK, discoveredItemType);

  const ledgerItems = await queryLedger(userId);
  const weekKeys = new Set<string>();
  const dayKeys = new Set<string>();
  for (const item of ledgerItems) {
    const sk = item.SK;
    if (sk.startsWith("AWARD#")) {
      add(item.PK, sk, "AWARD#");
      if (typeof item.week === "string") weekKeys.add(item.week);
    } else if (sk.startsWith("DAY#")) {
      add(item.PK, sk, "DAY#");
      const dayKey = sk.split("#")[1];
      if (dayKey) dayKeys.add(dayKey);
    } else if (sk === "REFERREDBY") {
      add(item.PK, sk, "REFERREDBY");
    }
  }

  const allTime = await client.send(
    new GetCommand({ TableName: TABLE, Key: { PK: "LB#ALLTIME", SK: `USER#${userId}` } })
  );
  if (allTime.Item) add("LB#ALLTIME", `USER#${userId}`, "LB#ALLTIME");

  for (const w of weekKeys) add(`LB#WEEK#${w}`, `USER#${userId}`, "LB#WEEK#");
  for (const d of dayKeys) add(`LB#DAY#${d}`, `USER#${userId}`, "LB#DAY#");

  return { keys, weekKeys: [...weekKeys], dayKeys: [...dayKeys] };
}

export interface DiscoveryResult {
  orphans: OrphanRecord[];
  candidateCount: number;
}

async function discoverOrphans(): Promise<DiscoveryResult> {
  const allTimeItems = await queryGsi3All("LB#ALLTIME");
  const candidateByUserId = new Map<string, RawItem>();
  for (const item of allTimeItems) {
    candidateByUserId.set(userIdFromLbItem(item), item);
  }

  const checkedIds = new Set(candidateByUserId.keys());
  const existing = await findExistingUserIds([...candidateByUserId.keys()]);
  const orphans: OrphanRecord[] = [];

  for (const [userId, item] of candidateByUserId) {
    if (existing.has(userId)) continue;
    const { keys, weekKeys, dayKeys } = await collectOrphanKeys(userId, item);
    orphans.push({
      userId,
      foundVia: "GSI3-ALLTIME",
      classification: classifyUserId(userId),
      weekKeys,
      dayKeys,
      keys,
    });
  }

  // Secondary sweep (defensive completeness check): every week/day key any
  // orphan's ledger touched, plus the current ISO week and today (UTC), even
  // if no orphan happened to touch them. In practice every LB#WEEK#/LB#DAY#
  // row an orphan has is written in the same transaction as its LB#ALLTIME
  // row, so this should find nothing new -- but it is what step 3 of the
  // ticket asks for, and it is cheap.
  const sweepWeekKeys = new Set<string>([isoWeekKey(new Date())]);
  const sweepDayKeys = new Set<string>([utcDateKey(new Date())]);
  for (const o of orphans) {
    o.weekKeys.forEach((w) => sweepWeekKeys.add(w));
    o.dayKeys.forEach((d) => sweepDayKeys.add(d));
  }

  const secondaryByUserId = new Map<string, RawItem>();
  for (const w of sweepWeekKeys) {
    for (const item of await queryGsi3All(`LB#WEEK#${w}`)) {
      const userId = userIdFromLbItem(item);
      if (!checkedIds.has(userId)) secondaryByUserId.set(userId, item);
    }
  }
  for (const d of sweepDayKeys) {
    for (const item of await queryGsi3All(`LB#DAY#${d}`)) {
      const userId = userIdFromLbItem(item);
      if (!checkedIds.has(userId)) secondaryByUserId.set(userId, item);
    }
  }

  if (secondaryByUserId.size > 0) {
    const secondaryExisting = await findExistingUserIds([...secondaryByUserId.keys()]);
    for (const [userId, item] of secondaryByUserId) {
      if (secondaryExisting.has(userId)) continue;
      const { keys, weekKeys, dayKeys } = await collectOrphanKeys(userId, item);
      orphans.push({
        userId,
        foundVia: "secondary-sweep",
        classification: classifyUserId(userId),
        weekKeys,
        dayKeys,
        keys,
      });
    }
  }

  return { orphans, candidateCount: candidateByUserId.size };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

interface FlatDeleteKey extends DeleteKey {
  userId: string;
}

interface DryRunFile {
  generatedAt: string;
  table: string;
  orphans: OrphanRecord[];
  deleteKeys: FlatDeleteKey[];
}

function buildDryRunFile(orphans: OrphanRecord[]): DryRunFile {
  const deleteKeys: FlatDeleteKey[] = orphans
    .filter((o) => o.classification === "test-pattern")
    .flatMap((o) => o.keys.map((k) => ({ ...k, userId: o.userId })));
  return { generatedAt: new Date().toISOString(), table: TABLE, orphans, deleteKeys };
}

function printSummary(dryRun: DryRunFile, outPath: string): void {
  const { orphans, deleteKeys } = dryRun;
  const testPattern = orphans.filter((o) => o.classification === "test-pattern");
  const other = orphans.filter((o) => o.classification === "other");
  const viaAllTime = orphans.filter((o) => o.foundVia === "GSI3-ALLTIME");
  const viaSecondary = orphans.filter((o) => o.foundVia === "secondary-sweep");

  console.log(`table: ${dryRun.table}`);
  console.log(`orphans found: ${orphans.length} (GSI3-ALLTIME sweep: ${viaAllTime.length}, secondary sweep only: ${viaSecondary.length})`);
  console.log(`  test-pattern: ${testPattern.length}`);
  console.log(`  other: ${other.length}`);

  if (other.length > 0) {
    console.log("\nSTOP: non-test-pattern orphans found, excluded from the delete set:");
    for (const o of other) console.log(`  ${o.userId}`);
  }

  const counts = new Map<string, number>();
  for (const k of deleteKeys) counts.set(k.itemType, (counts.get(k.itemType) ?? 0) + 1);
  console.log(`\ndelete set (test-pattern only): ${deleteKeys.length} keys`);
  for (const [itemType, count] of counts) console.log(`  ${itemType}: ${count}`);

  console.log("\nsample keys:");
  for (const k of deleteKeys.slice(0, 10)) {
    console.log(`  ${k.PK} / ${k.SK} (${k.itemType}, userId=${k.userId})`);
  }

  console.log(`\nwrote ${outPath}`);
}

async function runDryRun(): Promise<void> {
  const { orphans, candidateCount } = await discoverOrphans();
  console.log(`candidates on LB#ALLTIME: ${candidateCount}`);
  const dryRun = buildDryRunFile(orphans);
  const outPath = path.join(os.tmpdir(), `orphan-points-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(dryRun, null, 2));
  printSummary(dryRun, outPath);
}

// ---------------------------------------------------------------------------
// Apply (reads a dry-run file, does not re-discover)
// ---------------------------------------------------------------------------

// Pure so it's unit-testable without touching DynamoDB: given the dry run's
// delete set and a fresh check of which of those userIds still have no USER#
// item, splits the keys into what's still safe to delete and what must be
// skipped because that userId is no longer an orphan.
export function partitionForApply(
  deleteKeys: FlatDeleteKey[],
  stillOrphanUserIds: Set<string>
): { toDelete: FlatDeleteKey[]; skipped: FlatDeleteKey[] } {
  const toDelete = deleteKeys.filter((k) => stillOrphanUserIds.has(k.userId));
  const skipped = deleteKeys.filter((k) => !stillOrphanUserIds.has(k.userId));
  return { toDelete, skipped };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

async function runApply(dryRunPath: string): Promise<void> {
  const dryRun = JSON.parse(fs.readFileSync(dryRunPath, "utf8")) as DryRunFile;
  assertRequiredTable(dryRun.table);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(
    `About to delete ${dryRun.deleteKeys.length} keys from ${REQUIRED_TABLE}. Type the table name to confirm: `
  );
  rl.close();
  if (typed !== REQUIRED_TABLE) {
    console.log("Confirmation did not match. Aborting, nothing deleted.");
    return;
  }

  const userIds = [...new Set(dryRun.deleteKeys.map((k) => k.userId))];
  const existing = await findExistingUserIds(userIds);
  const stillOrphan = new Set(userIds.filter((id) => !existing.has(id)));
  const { toDelete, skipped } = partitionForApply(dryRun.deleteKeys, stillOrphan);

  if (skipped.length > 0) {
    const skippedUsers = [...new Set(skipped.map((k) => k.userId))];
    console.log(`Skipping ${skipped.length} keys for ${skippedUsers.length} userIds that now have a USER# item:`);
    for (const id of skippedUsers) console.log(`  ${id}`);
  }

  let deleted = 0;
  let alreadyGone = 0;
  for (const key of toDelete) {
    try {
      await client.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { PK: key.PK, SK: key.SK },
          ConditionExpression: "attribute_exists(PK)",
        })
      );
      deleted++;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        alreadyGone++;
      } else {
        throw err;
      }
    }
  }

  console.log(`deleted: ${deleted}, already gone: ${alreadyGone}, skipped (re-checked, no longer orphan): ${skipped.length}`);
}

// ---------------------------------------------------------------------------
// Entry point (only runs when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf("--apply");
  if (applyIndex !== -1) {
    const dryRunPath = args[applyIndex + 1];
    if (!dryRunPath) {
      console.error("--apply requires a path to a dry-run JSON file");
      process.exitCode = 1;
      return;
    }
    await runApply(dryRunPath);
  } else {
    await runDryRun();
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
