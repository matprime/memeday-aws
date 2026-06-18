const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      const stub = path.join(__dirname, "helpers", "next-cache-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

test("comments: adding a comment persists it and increments commentCount", async (t) => {
  if (!process.env.DYNAMODB_TABLE_NAME || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return;
  }

  const { createMeme, addComment, getComments, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

  const userId = `test_user_${Date.now()}`;

  const meme = await createMeme({
    creatorId: userId,
    s3Key: "test/comment-creation.png",
    caption: "test meme for comments",
    isNFT: false,
  });
  assert.ok(meme?.id, "expected created meme id");

  try {
    const comment = await addComment({
      memeId: meme.id,
      userId,
      body: "this is a test comment",
    });

    assert.ok(comment?.id, "addComment should return a comment with an id");
    assert.strictEqual(comment.memeId, meme.id, "comment memeId should match");
    assert.strictEqual(comment.body, "this is a test comment", "comment body should match");

    const comments = await getComments(meme.id);
    assert.strictEqual(comments.length, 1, "getComments should return the new comment");
    assert.strictEqual(comments[0].id, comment.id, "returned comment id should match");

    const memeAfter = await getMemeById(meme.id);
    assert.strictEqual(memeAfter.commentCount, 1, "commentCount on meme should be 1");
  } finally {
    // Clean up comments
    const { Items: commentItems } = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `MEME#${meme.id}`, ":prefix": "COMMENT#" },
      })
    );
    for (const item of commentItems ?? []) {
      await dynamo.send(
        new DeleteCommand({ TableName: TABLE, Key: { PK: item.PK, SK: item.SK } })
      );
    }
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } })
    );
  }
});
