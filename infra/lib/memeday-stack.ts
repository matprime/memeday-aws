import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

export class MemeDayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isProd = this.node.tryGetContext("prod") !== "false";
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // S3 bucket: private, presigned-upload CORS, CloudFront OAC is the only read path
    const bucket = new s3.Bucket(this, "MemeDayBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      removalPolicy,
    });

    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });

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

    // Lambda: DynamoDB Streams → materialize FEED#GLOBAL and LEADERBOARD#GLOBAL views
    const streamHandler = new lambdaNodejs.NodejsFunction(this, "StreamHandler", {
      entry: path.join(__dirname, "../../lambdas/stream-handler/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      environment: { TABLE_NAME: table.tableName },
    });

    table.grantStreamRead(streamHandler);
    table.grantWriteData(streamHandler);

    streamHandler.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        bisectBatchOnError: true,
        retryAttempts: 3,
      })
    );

    new cdk.CfnOutput(this, "StreamHandlerArn", {
      value: streamHandler.functionArn,
    });

    // Lambda: daily cron — archive featured meme + score decay
    const cronHandler = new lambdaNodejs.NodejsFunction(this, "CronHandler", {
      entry: path.join(__dirname, "../../lambdas/cron-handler/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      environment: { TABLE_NAME: table.tableName },
    });

    table.grantReadWriteData(cronHandler);

    new events.Rule(this, "DailyCronRule", {
      schedule: events.Schedule.cron({ hour: "0", minute: "0" }),
      targets: [new eventsTargets.LambdaFunction(cronHandler)],
    });

    // Secrets Manager: platform Solana keypair for server-side on-chain signing
    // After deploy, set the secret value to a JSON array of 64 bytes: [n, n, ...]
    const platformKeypairSecret = new secretsmanager.Secret(
      this,
      "PlatformKeypairSecret",
      {
        description:
          "Solana platform keypair for server-side on-chain signing (JSON array of 64 bytes)",
        removalPolicy,
      }
    );

    new cdk.CfnOutput(this, "PlatformKeypairSecretArn", {
      value: platformKeypairSecret.secretArn,
    });

    // Grant cron handler PutEvents so it can emit daily-winner-archived
    const defaultBus = events.EventBus.fromEventBusArn(
      this,
      "DefaultEventBus",
      `arn:aws:events:${this.region}:${this.account}:event-bus/default`
    );
    defaultBus.grantPutEventsTo(cronHandler);

    // Lambda: on-chain signing — mints Meme of Day NFT using platform keypair
    const onchainSigner = new lambdaNodejs.NodejsFunction(
      this,
      "OnchainSigner",
      {
        entry: path.join(
          __dirname,
          "../../lambdas/onchain-signer/index.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(5),
        environment: {
          TABLE_NAME: table.tableName,
          PLATFORM_KEYPAIR_SECRET_ARN: platformKeypairSecret.secretArn,
          APP_URL: this.node.tryGetContext("appUrl") ?? "",
          CLOUDFRONT_DOMAIN: this.node.tryGetContext("cloudfrontDomain") ?? "",
        },
      }
    );

    table.grantReadWriteData(onchainSigner);
    platformKeypairSecret.grantRead(onchainSigner);

    // Triggered by cron's daily-winner-archived EventBridge event
    new events.Rule(this, "DailyWinnerArchivedRule", {
      eventPattern: {
        source: ["memeday.platform"],
        detailType: ["daily-winner-archived"],
      },
      targets: [new eventsTargets.LambdaFunction(onchainSigner)],
    });

    // Lambda: S3 ObjectCreated → validate content-type and file size, delete rejects
    const s3Handler = new lambdaNodejs.NodejsFunction(this, "S3Handler", {
      entry: path.join(__dirname, "../../lambdas/s3-handler/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
    });

    bucket.grantRead(s3Handler);
    bucket.grantDelete(s3Handler);

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(s3Handler)
    );
  }
}
