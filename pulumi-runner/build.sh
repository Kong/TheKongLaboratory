#!/bin/bash
clear

fetch_vars () {
echo ">> Collecting run variables"
export vargitref=$(git rev-parse --short HEAD)
export varrundate=$(date +%y%m%d%I%M)
export varverkubectl=$(curl -sL curl -L -s https://dl.k8s.io/release/stable.txt)
export varverpulumi=$(curl -s https://api.github.com/repos/pulumi/pulumi/releases/latest | awk -F '["v,]' '/tag_name/{print $5}')

cat <<EOF
>> Detected:
      GitRef:             $vargitref
      RunDate:            $varrundate
      Kubectl:            $varverkubectl
      Pulumi:             $varverpulumi
EOF
}

pull_images () {
PULL_LIST="\
registry.access.redhat.com/ubi8/ubi \
"

for i in ${PULL_LIST}; do
  echo ">>  Pulling image: $i"
  sudo docker pull $i
  echo
done
}

run_build () {
  echo ">> Building Pulumi Runner"
  sudo docker build \
    -f Dockerfile \
    --build-arg varverpulumi=$varverpulumi \
    --build-arg varverkubectl=$varverkubectl \
    -t localhost/pulumi-runner:${varrundate}-${vargitref} \
  .
  echo
}

run_test () {
  sudo docker run \
      -it \
      --rm \
      --entrypoint /test.sh \
      --volume $(pwd)/test.sh:/test.sh \
    localhost/pulumi-runner:${varrundate}-${vargitref}
}

main () {
  clear
  fetch_vars
  pull_images
  run_build
  run_test
  cd $START_DIR
  echo "built image localhost/pulumi-runner:${varrundate}-${vargitref}"
}

main
