import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

export const dynamo = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const tableName = process.env.DYNAMODB_TABLE_NAME;
if (!tableName) {
  throw new Error("Missing DYNAMODB_TABLE_NAME");
}
export const TABLE = tableName;
