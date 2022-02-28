#!/bin/bash -x
clear
project="pulumi-runner"
docker run -it --rm --pull always \
    -v ${PWD}:/pulumi:z \
    -e AWS_ACCESS_KEY_ID=$(awk '/aws_access_key_id/{print $3}' ~/.aws/credentials) \
    -e AWS_SECRET_ACCESS_KEY=$(awk '/aws_secret_access_key/{print $3}' ~/.aws/credentials) \
    -e PULUMI_ACCESS_TOKEN=$(awk -F'[",: ]' '/            "accessToken/{print $18}' ~/.pulumi/credentials.json) \
    --name pulumi-runner --hostname pulumi-runner \
    --entrypoint bash --workdir /pulumi/pulumi \
   ghcr.io/usrbinkat/pulumi-runner
