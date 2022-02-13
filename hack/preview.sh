#!/bin/bash -x
project="deploy-${git_repo}"
time docker run -it --rm --pull always \
    -v ${PWD}:/pulumi:z \
    --env-file $HOME/Git/tmp/pulumi-runner/env \
   ghcr.io/usrbinkat/pulumi-runner \
     pulumi preview --stack KongOnEKS --cwd /pulumi/pulumi --non-interactive
