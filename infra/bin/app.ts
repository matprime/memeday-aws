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

new MemeDayStack(app, "MemeDayStack", {
  env: { region },
});
