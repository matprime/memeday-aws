// Stand-in for lib/dynamo.ts, used only by test/batch-get-chunking.test.js so
// the >100-key BatchGet chunking/retry logic in lib/db.ts can be exercised
// without a live DynamoDB table. Rejects any BatchGetCommand with more than
// 100 keys, the same constraint DynamoDB itself enforces, so a regression
// that sends an unchunked batch fails the test instead of a real request.
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

export const TABLE = "TestTable";

export const state = {
  items: new Map(),
  feedItems: [],
  batchCallCount: 0,
  maxKeysPerCall: 0,
  splitFirstCall: false,
  queryCallCount: 0,
};

function itemKey(pk, sk) {
  return `${pk}#${sk}`;
}

export function resetStub() {
  state.items = new Map();
  state.feedItems = [];
  state.batchCallCount = 0;
  state.maxKeysPerCall = 0;
  state.splitFirstCall = false;
  state.queryCallCount = 0;
}

export function seedItem(pk, sk, item) {
  state.items.set(itemKey(pk, sk), item);
}

export const dynamo = {
  async send(command) {
    if (command instanceof BatchGetCommand) {
      const keys = command.input.RequestItems[TABLE].Keys;
      if (keys.length > 100) {
        throw new Error(
          "ValidationException: Value at 'RequestItems.TestTable.member.Keys' failed to satisfy constraint: Member must have length less than or equal to 100"
        );
      }
      state.batchCallCount += 1;
      state.maxKeysPerCall = Math.max(state.maxKeysPerCall, keys.length);

      let served = keys;
      let unprocessed = [];
      if (state.splitFirstCall && state.batchCallCount === 1 && keys.length > 1) {
        const mid = Math.ceil(keys.length / 2);
        served = keys.slice(0, mid);
        unprocessed = keys.slice(mid);
      }

      const Responses = {
        [TABLE]: served
          .map((k) => state.items.get(itemKey(k.PK, k.SK)))
          .filter((item) => item !== undefined),
      };
      const result = { Responses };
      if (unprocessed.length > 0) {
        result.UnprocessedKeys = { [TABLE]: { Keys: unprocessed } };
      }
      return result;
    }
    if (command instanceof QueryCommand) {
      state.queryCallCount += 1;
      const input = command.input;
      const pk = input.ExpressionAttributeValues?.[":pk"];
      let items = state.feedItems.filter((i) => i.GSI3PK === pk);

      const forward = input.ScanIndexForward !== false;
      items = [...items].sort((a, b) =>
        forward
          ? a.GSI3SK < b.GSI3SK ? -1 : 1
          : a.GSI3SK < b.GSI3SK ? 1 : -1
      );

      if (input.ExclusiveStartKey) {
        const idx = items.findIndex((i) => i.GSI3SK === input.ExclusiveStartKey.GSI3SK);
        items = idx >= 0 ? items.slice(idx + 1) : items;
      }

      let LastEvaluatedKey;
      if (input.Limit && items.length > input.Limit) {
        LastEvaluatedKey = { GSI3PK: pk, GSI3SK: items[input.Limit - 1].GSI3SK };
        items = items.slice(0, input.Limit);
      }

      const result = { Items: items };
      if (LastEvaluatedKey) result.LastEvaluatedKey = LastEvaluatedKey;
      return result;
    }
    throw new Error(`db-dynamo-stub: unhandled command ${command.constructor.name}`);
  },
};
