import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Construct } from "constructs";

export interface MemeDayStackProps extends cdk.StackProps {
  stage: "prod" | "dev";
  alertEmails: string[];
}

export class MemeDayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemeDayStackProps) {
    super(scope, id, props);

    // Both stages synthesize the same resources. Stage only affects resource
    // names and how aggressively things are deleted, so anything verified
    // against MemeDayDev is a real signal about MemeDayStack.
    const isProd = props.stage === "prod";
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const table = new dynamodb.Table(this, "MemeDayTable", {
      // Prod table renamed to start clean. The live "MemeDay" table has zero
      // GSIs and CloudFormation can only add one GSI per update, so a rename
      // creates all three at table-creation time in a single deploy instead.
      // RETAIN keeps the old table as the rollback artifact.
      tableName: isProd ? "MemeDayProd" : "MemeDayDev",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy,
      // Sweeps stale/rejected PENDING# upload records after 24h, and RATE#
      // counter items shortly after their window closes (see lib/rate-limit.ts).
      // Only those two prefixes are written with expiresAt, so memes, users,
      // and comments are never affected by TTL.
      timeToLiveAttribute: "expiresAt",
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

    // --- Alerting: SNS topic + CloudWatch alarms ---
    // Distinct topic names per stage: both stacks share one account, so a
    // literal "memeday-alerts" in both would collide.
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: isProd ? "memeday-alerts" : "memeday-alerts-dev",
      displayName: "MemeDay Alerts",
    });
    props.alertEmails.forEach((email) =>
      alertTopic.addSubscription(new subs.EmailSubscription(email))
    );
    const alertAction = new cwActions.SnsAction(alertTopic);

    this.addErrorsAlarm(streamHandler, "StreamHandler", alertAction);

    // DynamoDB throttling (table + GSIs) — PAY_PER_REQUEST can still throttle.
    new cloudwatch.Alarm(this, "TableThrottleAlarm", {
      metric: table.metric("ThrottledRequests", {
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "MemeDay table throttled requests",
    }).addAlarmAction(alertAction);

    // lib/rate-limit.ts is fail-open: a failed counter write logs and lets the
    // request through, so nobody is rate limited until it recovers. Nothing
    // surfaces that on its own. The threshold is deliberately not zero, since
    // isolated DynamoDB faults are expected and self-healing.
    new cloudwatch.Alarm(this, "RateLimitCounterFailureAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "MemeDay",
        metricName: "RateLimitCounterFailure",
        // Must match the Stage dimension emitted by lib/rate-limit.ts, or dev
        // and prod would read each other's data.
        dimensionsMap: { Stage: props.stage },
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 20,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "MemeDay rate limit counter write failures",
    }).addAlarmAction(alertAction);

    new cdk.CfnOutput(this, "AlertTopicArn", { value: alertTopic.topicArn });

    // --- S3 bucket + image validation handler ---
    // autoDeleteObjects runs a custom resource that empties the bucket when the
    // stack is deleted. Fine in dev, unacceptable in prod: a failed deploy that
    // rolls back would take live media with it. Prod relies on RETAIN instead.
    const bucket = new s3.Bucket(this, "MemeDayBucket", {
      removalPolicy,
      autoDeleteObjects: !isProd,
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

    this.addErrorsAlarm(s3Handler, "S3Handler", alertAction);

    // --- Rekognition content moderation handler (KAN-44) ---
    // No S3 event subscription of its own: S3 rejects two overlapping
    // OBJECT_CREATED/prefix subscriptions as ambiguous. Instead S3Handler
    // invokes this Lambda directly (async) once it finishes validating and
    // re-encoding an upload, so it always runs after S3Handler's format/size
    // validation, on the final asset.
    const moderationHandler = new NodejsFunction(this, "ModerationHandler", {
      entry: path.join(__dirname, "../../lambdas/moderation-handler/index.ts"),
      projectRoot: path.join(__dirname, "../.."),
      depsLockFilePath: path.join(__dirname, "../../package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DYNAMODB_TABLE_NAME: table.tableName,
      },
    });

    // Rekognition's image APIs don't support resource-level ARNs for
    // DetectModerationLabels — actions: ["*"] is the API's own constraint,
    // not a scoping choice. s3:GetObject is what lets Rekognition read the
    // S3Object on this function's behalf, scoped to uploads/* like S3Handler.
    moderationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:DetectModerationLabels"],
        resources: ["*"],
      })
    );
    moderationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${bucket.bucketArn}/uploads/*`],
      })
    );

    // Own execution role, separate from S3Handler's and from the KAN-17
    // runtime users — table.grantReadWriteData grants only this function's role.
    table.grantReadWriteData(moderationHandler);

    this.addErrorsAlarm(moderationHandler, "ModerationHandler", alertAction);

    // S3Handler invokes ModerationHandler directly after validation succeeds
    // (see lambdas/s3-handler) — scoped to this one function, not "*".
    s3Handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [moderationHandler.functionArn],
      })
    );
    s3Handler.addEnvironment("MODERATION_HANDLER_FUNCTION_NAME", moderationHandler.functionName);

    // --- CloudFront: only public path to the media bucket (OAC, no public bucket policy) ---
    const distribution = new cloudfront.Distribution(this, "MemeDayDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // --- Vercel runtime IAM user (KAN-17) ---
    // memeday-runtime-prod / memeday-runtime-dev already exist in AWS,
    // created out-of-band before this stack managed them. A one-time
    // `cdk import` per stack is required to adopt each into CloudFormation
    // state before `cdk deploy` will succeed against them — CreateUser fails
    // loud (EntityAlreadyExists) rather than duplicating on a plain deploy.
    // Action lists below are grepped from actual AWS SDK calls in app/ and
    // lib/, not guessed (see KAN-17 step 3).
    const runtimeUser = new iam.User(this, "RuntimeUser", {
      userName: isProd ? "memeday-runtime-prod" : "memeday-runtime-dev",
    });

    runtimeUser.attachInlinePolicy(
      new iam.Policy(this, "RuntimeUserPolicy", {
        statements: [
          // DynamoDB — actions used by lib/db.ts. Scan excluded: getAllUsers
          // (lib/db.ts:449) has zero callers, so it's unused per KAN-17's
          // no-unused-permissions acceptance criteria.
          new iam.PolicyStatement({
            actions: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:Query",
              "dynamodb:BatchGetItem",
            ],
            resources: [table.tableArn, `${table.tableArn}/index/*`],
          }),
          // Cognito — the 10 actions used across app/api/auth/**.
          new iam.PolicyStatement({
            actions: [
              "cognito-idp:SignUp",
              "cognito-idp:ConfirmSignUp",
              "cognito-idp:ForgotPassword",
              "cognito-idp:ConfirmForgotPassword",
              "cognito-idp:ResendConfirmationCode",
              "cognito-idp:ListUsers",
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminInitiateAuth",
              "cognito-idp:AdminSetUserPassword",
            ],
            resources: [userPool.userPoolArn],
          }),
          // S3 — PutObject only (upload-url route). GetObject deliberately
          // excluded per KAN-38: the image proxy route is reachable by
          // direct URL regardless of CLOUDFRONT_DOMAIN, and the decision
          // was to accept a 500 on that path rather than keep the grant.
          new iam.PolicyStatement({
            actions: ["s3:PutObject"],
            resources: [`${bucket.bucketArn}/uploads/*`],
          }),
          // CloudWatch — PutMetricData for the RateLimitCounterFailure metric
          // emitted by lib/rate-limit.ts. PutMetricData doesn't support
          // resource-level ARNs, so resources: ["*"] is the API's own
          // constraint, not a scoping choice. The namespace condition is what
          // actually scopes it: this user can only write into MemeDay.
          new iam.PolicyStatement({
            actions: ["cloudwatch:PutMetricData"],
            resources: ["*"],
            conditions: {
              StringEquals: { "cloudwatch:namespace": "MemeDay" },
            },
          }),
        ],
      })
    );

    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "S3HandlerArn", { value: s3Handler.functionArn });
    new cdk.CfnOutput(this, "ModerationHandlerArn", { value: moderationHandler.functionArn });
    new cdk.CfnOutput(this, "Region", { value: this.region });
    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
    });
  }

  // Errors > 0 over a 5-minute window → notify. NOT_BREACHING keeps the alarm
  // quiet when the function simply isn't invoked (no data ≠ error).
  private addErrorsAlarm(
    fn: NodejsFunction,
    id: string,
    action: cwActions.SnsAction
  ) {
    new cloudwatch.Alarm(this, `${id}ErrorsAlarm`, {
      metric: fn.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `${id} Lambda reported errors`,
    }).addAlarmAction(action);
  }
}
