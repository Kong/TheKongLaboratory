#!/bin/sh

helm upgrade --install -nkong postgres     --values postgres.yml     bitnami/postgresql
helm upgrade --install -nkong controlplane --values controlplane.yml kong/kong
helm upgrade --install -nkong dataplane    --values dataplane.yml    kong/kong

helm upgrade --install -nkong controller-default --values default-controller.yml kong/kong
helm upgrade --install -nkong controller-public  --values public-controller.yml  kong/kong

helm upgrade --install -nkong developer-portal --values developer-portal.yml kong/kong
