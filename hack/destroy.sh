#!/bin/bash -x
git_repo=KongOnEKS
project="deploy-${git_repo}"
tmpDir="${HOME}/Git/tmp/pulumi-runner"

rm -fr ${tmpDir}
mkdir -p ${tmpDir}/{ssh,aws,kube,gitconfig}
cp -fr ${HOME}/.gitconfig ${tmpDir}/gitconfig
cp -fr ${HOME}/.kube ${tmpDir}/kube
cp -fr ${HOME}/.aws ${tmpDir}/aws
cp -fr ${HOME}/.ssh ${tmpDir}/ssh

docker run -it --rm --pull always \
    -v ${PWD}:/pulumi:z \
    --name "${project}" -h "${project}" --user root \
    --env-file /tmp/env \
    --entrypoint pulumi \
   ghcr.io/usrbinkat/pulumi-runner \
     destroy --stack KongOnEKS --yes --cwd /pulumi/pulumi --non-interactive
