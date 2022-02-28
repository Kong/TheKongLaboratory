#!/bin/bash -x
podman run -q -it --rm \
    -v ${PWD}:/pulumi:z \
    --workdir /pulumi/pulumi \
    -e AWS_ACCESS_KEY_ID=$(awk '/aws_access_key_id/{print $3}' ~/.aws/credentials) \
    -e AWS_SECRET_ACCESS_KEY=$(awk '/aws_secret_access_key/{print $3}' ~/.aws/credentials) \
    -e PULUMI_ACCESS_TOKEN=$(awk -F'[",: ]' '/            "accessToken/{print $18}' ~/.pulumi/credentials.json) \
   ghcr.io/usrbinkat/pulumi-runner /bin/bash -c \
     "pulumi stack --stack KongOnEKS output kubeconfig" \
| grep -v PULUMI_ACCESS_TOKEN \
| jq . \
| yq eval -P \
| tee ~/.kube/pulumi-eks
