const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

// The REPORTQUEUE#GLOBAL row is not written by createReport. StreamHandler
// writes it asynchronously off the REPORT# insert, so by the time a test's
// finally block runs the row usually does not exist yet. A plain delete here
// would race the stream, win, delete nothing, and the row would then appear
// anyway and stay forever: StreamHandler has no REMOVE branch for REPORT#
// items, so nothing ever cleans it up. That is how the dev queue accumulated
// 36 orphan rows pointing at deleted test memes.
//
// So we wait for the row instead of assuming it is there. Note the tests also
// delete the MEME# item in the same finally: if that delete lands first,
// upsertReportQueueItem finds no meme and writes nothing, so the row never
// appears and the poll correctly times out with nothing to do.

const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 5000;

// Poll until StreamHandler's row shows up, or give up. Returns the item so a
// caller can assert the stream actually did its work rather than silently
// passing on a row that never arrived.
async function waitForReportQueueItem(dynamo, TABLE, memeId) {
  const key = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: key }));
    if (Item) return Item;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return undefined;
}

async function deleteReportQueueItemWhenSettled(dynamo, TABLE, memeId) {
  const key = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };
  const item = await waitForReportQueueItem(dynamo, TABLE, memeId);
  if (item) {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: key }));
    return true;
  }
  // Timed out. Either the stream never wrote a row (the MEME# delete won the
  // race) or it is slower than the timeout. Delete unconditionally as a cheap
  // last attempt, then warn: a leaked row is not worth failing a test over,
  // but it should not be silent either, or the queue quietly refills.
  await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: key }));
  console.warn(
    `report queue cleanup: no REPORTQUEUE#GLOBAL row for ${memeId} within ${TIMEOUT_MS}ms; ` +
      "if one appears later it will need clearing by hand"
  );
  return false;
}

module.exports = { deleteReportQueueItemWhenSettled, waitForReportQueueItem };
