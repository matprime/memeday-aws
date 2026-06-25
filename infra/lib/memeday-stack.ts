import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

export class MemeDayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isProd = this.node.tryGetContext("prod") !== "false";
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const table = new dynamodb.Table(this, "MemeDayTable", {
      tableName: "MemeDay",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy,
    });

    // GSI1: creator's memes — GSI1PK = USER#<creatorId>
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI2: wallet → user lookup — GSI2PK = WALLET#<addr>
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI3: reserved for feed/market materialized views (Lambda Streams)
    table.addGlobalSecondaryIndex({
      indexName: "GSI3",
      partitionKey: { name: "GSI3PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: dynamodb.AttributeType.STRING },
    });

    // Opaque usernames (wallet_<addr>) with email as an optional sign-in alias.
    // Email must NOT be a username attribute or required — wallet-only sign-up
    // is valid (see CLAUDE.md: email OR wallet alone).
    const userPool = new cognito.UserPool(this, "MemeDayUserPool", {
      userPoolName: "MemeDay",
      selfSignUpEnabled: true,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: false, mutable: true },
      },
      customAttributes: {
        walletAddr: new cognito.StringAttribute({ mutable: true }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });

    const userPoolClient = userPool.addClient("MemeDayWebClient", {
      authFlows: {
        adminUserPassword: true, // wallet login via /api/auth/wallet/verify
        userSrp: true, // email/password login
      },
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });

    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "TableArn", { value: table.tableArn });
    new cdk.CfnOutput(this, "StreamArn", {
      value: table.tableStreamArn ?? "streams-not-enabled",
    });

const streamHandler = new NodejsFunction(this, "StreamHandler", {
      entry: path.join(__dirname, "../../lambdas/stream-handler/index.ts"),
      // entry sits in the repo root (../../), so projectRoot must point there too —
      // otherwise CDK treats infra/ as the root and rejects the path as outside it.
      projectRoot: path.join(__dirname, "../.."),
      depsLockFilePath: path.join(__dirname, "../../package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DYNAMODB_TABLE_NAME: table.tableName,
      },
    });

    table.grantReadWriteData(streamHandler);

    streamHandler.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        bisectBatchOnError: true,
        retryAttempts: 3,
      })
    );

    new cdk.CfnOutput(this, "StreamHandlerArn", {
      value: streamHandler.functionArn,
    });
  }
}
