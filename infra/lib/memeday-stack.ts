import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Construct } from "constructs";

export interface MemeDayStackProps extends cdk.StackProps {
  stage: "prod" | "dev";
}

export class MemeDayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemeDayStackProps) {
    super(scope, id, props);

    const isProd = props.stage === "prod";
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const table = new dynamodb.Table(this, "MemeDayTable", {
      tableName: isProd ? "MemeDay" : "MemeDayDev",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy,
      // Dev-only: sweeps stale/rejected PENDING# upload records after 24h.
      // Omitted for prod (undefined) to keep the prod table definition unchanged.
      timeToLiveAttribute: isProd ? undefined : "expiresAt",
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
      userPoolName: isProd ? "MemeDay" : "MemeDayDev",
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
      runtime: lambda.Runtime.NODEJS_22_X,
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

    // Dev-only: prod's media bucket lives outside CDK and must stay untouched.
    // Outputs below are dev-only to keep the prod template unchanged.
    if (!isProd) {
      // --- S3 bucket + image validation handler ---
      const bucket = new s3.Bucket(this, "MemeDayBucket", {
        removalPolicy,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        cors: [
          {
            allowedMethods: [s3.HttpMethods.PUT],
            allowedOrigins: ["*"],
            allowedHeaders: ["*"],
            maxAge: 3000,
          },
        ],
      });

      const s3Handler = new NodejsFunction(this, "S3Handler", {
        entry: path.join(__dirname, "../../lambdas/s3-handler/index.ts"),
        projectRoot: path.join(__dirname, "../.."),
        depsLockFilePath: path.join(__dirname, "../../package-lock.json"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        // sharp needs headroom to decode/re-encode up to 4096x4096 images.
        memorySize: 512,
        environment: {
          S3_BUCKET_NAME: bucket.bucketName,
          DYNAMODB_TABLE_NAME: table.tableName,
        },
        // sharp ships a native binary — install it into the bundle rather than
        // letting esbuild try to inline it. Local build host is linux x64,
        // matching the default Lambda architecture, so no cross-compile needed.
        bundling: {
          nodeModules: ["sharp"],
        },
      });

      // Least-privilege: only /uploads/*, no wildcard bucket resource.
      s3Handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${bucket.bucketArn}/uploads/*`],
        })
      );

      table.grantReadWriteData(s3Handler);

      bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new LambdaDestination(s3Handler),
        { prefix: "uploads/" }
      );

      new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
      new cdk.CfnOutput(this, "S3HandlerArn", { value: s3Handler.functionArn });
      new cdk.CfnOutput(this, "Region", { value: this.region });

// --- CloudFront: only public path to the media bucket (OAC, no public bucket policy) ---
      const distribution = new cloudfront.Distribution(this, "MemeDayDistribution", {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      });

      new cdk.CfnOutput(this, "CloudFrontDomain", { value: distribution.distributionDomainName });
    }
  }
}
