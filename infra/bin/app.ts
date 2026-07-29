#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MemeDayStack } from "../lib/memeday-stack";

const app = new cdk.App();

const region: string =
  app.node.tryGetContext("region") ??
  process.env.CDK_DEFAULT_REGION ??
  process.env.AWS_REGION ??
  "eu-west-1";

const alertEmails: string[] = (process.env.ALERT_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

new MemeDayStack(app, "MemeDayStack", {
  env: { region },
  stage: "prod",
  alertEmails,
});

new MemeDayStack(app, "MemeDayDev", {
  env: { region },
  stage: "dev",
  alertEmails,
});
