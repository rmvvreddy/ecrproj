#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcrprojStack } from '../lib/ecrproj-stack';

const app = new cdk.App();
new EcrprojStack(app, 'EcrprojStack', {
 
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  }
});