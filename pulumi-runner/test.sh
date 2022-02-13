#!/bin/bash
pulumi login --local
pulumi new aws-typescript --yes --stack eksGateway --generate-only --name KongOnEKS --description KongOnEKS --non-interactive
npm install
