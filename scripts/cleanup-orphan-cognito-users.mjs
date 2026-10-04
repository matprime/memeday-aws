#!/usr/bin/env node
/**
 * Audit and purge orphaned Cognito users in the MemeDay DEV user pool.
 *
 * Orphan = a Cognito user whose `sub` has no `USER#<sub>` item in MemeDayDev.
 * Those are left behind when a local test run (or an abandoned local signup)
 * creates the identity but never writes the profile row, and cleanup could not
 * call AdminDeleteUser because the dev runtime principal is not granted it.
 *
 * Why the DynamoDB join rather than a username prefix: wallet test users are
 * named `wallet_<random address>`, so there is no reliable prefix to match on.
 * The missing profile row is the only deterministic signal available.
 *
 * Dry run by default. Nothing is deleted without --apply, and --apply needs an
 * operator principal (AdminDeleteUser is deliberately not on memeday-runtime-dev).
 *
 * Usage:
 *   node scripts/cleanup-orphan-cognito-users.mjs --pool-id eu-west-1_XXXX --table MemeDayDev
 *   AWS_PROFILE=<operator> node scripts/cleanup-orphan-cognito-users.mjs --pool-id ... --table MemeDayDev --apply
 *
 * Flags:
 *   --pool-id <id>          required, dev user pool id
 *   --table <name>          required, must end in "Dev"
 *   --region <name>         default eu-west-1
 *   --min-age-hours <n>     default 24, skip users younger than this
 *   --keep <username|sub>   repeatable, never delete these
 *   --out <path>            report path, default ./.cleanup-reports/<timestamp>.json
 *   --apply                 actually delete. Omit for a dry run.
 */

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

// Hard stop: this script must never be pointed at production.
const PROD_POOL_ID = "eu-west-1_cL1sFIBms";

const { values } = parseArgs({
  options: {
    "pool-id": { type: "string" },
    table: { type: "string" },
    region: { type: "string", default: "eu-west-1" },
    "min-age-hours": { type: "string", default: "24" },
    keep: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const poolId = values["pool-id"] ?? process.env.COGNITO_USER_POOL_ID;
const table = values.table ?? process.env.DYNAMODB_TABLE_NAME;
const minAgeHours = Number(values["min-age-hours"]);
const keep = new Set(values.keep);
const outPath =
  values.out ?? `./.cleanup-reports/orphan-cognito-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!poolId) fail("--pool-id is required (or set COGNITO_USER_POOL_ID)");
if (!table) fail("--table is required (or set DYNAMODB_TABLE_NAME)");
if (poolId === PROD_POOL_ID) fail("refusing to run against the production user pool");
if (!/Dev$/.test(table)) fail(`refusing to run against table "${table}": name must end in "Dev"`);
if (!Number.isFinite(minAgeHours) || minAgeHours < 0) fail("--min-age-hours must be a non-negative number");

const idp = new CognitoIdentityProviderClient({ region: values.region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: values.region }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page through every user in the pool. ListUsers is granted to the dev runtime user. */
async function listAllUsers() {
  const users = [];
  let token;
  do {
    const res = await idp.send(
      new ListUsersCommand({ UserPoolId: poolId, Limit: 60, PaginationToken: token }),
    );
    for (const u of res.Users ?? []) {
      const attrs = Object.fromEntries((u.Attributes ?? []).map((a) => [a.Name, a.Value]));
      users.push({
        username: u.Username,
        sub: attrs.sub,
        email: attrs.email,
        status: u.UserStatus,
        enabled: u.Enabled,
        createdAt: u.UserCreateDate?.toISOString(),
        createDateMs: u.UserCreateDate?.getTime(),
      });
    }
    token = res.PaginationToken;
  } while (token);
  return users;
}

/** Return the set of subs that DO have a USER# profile row. BatchGet caps at 100 keys. */
async function findSubsWithProfile(subs) {
  const found = new Set();
  for (let i = 0; i < subs.length; i += 100) {
    let keys = subs.slice(i, i + 100).map((sub) => ({ PK: `USER#${sub}`, SK: `USER#${sub}` }));
    // UnprocessedKeys comes back on throttling, so retry whatever was left behind.
    while (keys.length) {
      const res = await ddb.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ProjectionExpression: "PK" } } }),
      );
      for (const item of res.Responses?.[table] ?? []) found.add(item.PK.slice("USER#".length));
      keys = res.UnprocessedKeys?.[table]?.Keys ?? [];
      if (keys.length) await sleep(500);
    }
  }
  return found;
}

const users = await listAllUsers();
const cutoffMs = Date.now() - minAgeHours * 3600_000;

const noSub = users.filter((u) => !u.sub);
const candidates = users.filter((u) => u.sub);
const tooYoung = candidates.filter((u) => (u.createDateMs ?? 0) > cutoffMs);
const allowlisted = candidates.filter(
  (u) => (u.createDateMs ?? 0) <= cutoffMs && (keep.has(u.username) || keep.has(u.sub)),
);
const checkable = candidates.filter(
  (u) => (u.createDateMs ?? 0) <= cutoffMs && !keep.has(u.username) && !keep.has(u.sub),
);

const withProfile = await findSubsWithProfile(checkable.map((u) => u.sub));
const orphans = checkable.filter((u) => !withProfile.has(u.sub));

console.log(`pool              ${poolId}`);
console.log(`table             ${table}`);
console.log(`total users       ${users.length}`);
console.log(`skipped: no sub   ${noSub.length}`);
console.log(`skipped: < ${minAgeHours}h   ${tooYoung.length}`);
console.log(`skipped: keep     ${allowlisted.length}`);
console.log(`has USER# row     ${checkable.length - orphans.length}`);
console.log(`ORPHANS           ${orphans.length}`);

const report = {
  generatedAt: new Date().toISOString(),
  poolId,
  table,
  minAgeHours,
  applied: values.apply,
  counts: {
    total: users.length,
    noSub: noSub.length,
    tooYoung: tooYoung.length,
    allowlisted: allowlisted.length,
    withProfile: checkable.length - orphans.length,
    orphans: orphans.length,
  },
  orphans,
  deleted: [],
  failed: [],
};

if (!values.apply) {
  // The report doubles as the backup: review it before rerunning with --apply.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nDRY RUN. No users deleted. Report: ${outPath}`);
  console.log("Review the report, then rerun with --apply using an operator principal.");
  process.exit(0);
}

for (const u of orphans) {
  try {
    await idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: u.username }));
    report.deleted.push(u);
    console.log(`deleted ${u.username}`);
  } catch (err) {
    report.failed.push({ ...u, error: err.name });
    console.error(`FAILED  ${u.username}: ${err.name}`);
    if (err.name === "AccessDeniedException") {
      console.error("AdminDeleteUser is not granted to this principal. Use an operator profile.");
      break;
    }
  }
  await sleep(150); // AdminDeleteUser is quota limited, stay well under it
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\ndeleted ${report.deleted.length}, failed ${report.failed.length}. Report: ${outPath}`);
