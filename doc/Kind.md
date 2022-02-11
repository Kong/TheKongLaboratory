# Create [KinD](https://kind.sigs.k8s.io) Cluster

#### Dependencies:
  - [docker](https://docs.docker.com/engine/reference/run) or [docker-desktop](https://www.docker.com/products/docker-desktop)
  - [Kind](https://kind.sigs.k8s.io)
  - [Kubectl](https://kubernetes.io/docs/reference/kubectl/kubectl) ([Linux](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux) / Mac](https://kubernetes.io/docs/tasks/tools/install-kubectl-macos))

#### How To:
```sh
docker volume create worker1-containerd
docker volume create control1-containerd
kind create cluster --config platform/kind/config.yml
```
