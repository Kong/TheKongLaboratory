import * as k8s from "@pulumi/kubernetes";
import * as pulumi from '@pulumi/pulumi';
import {env} from 'process';

// KubeConfig Context
const kubeConfigContext = 'kind-kong';

// App Namespaces
export const nsNameAppsDefault = 'demo';

// Export the cluster's kubeconfig.
const kubeconfig = new k8s.Provider('kubeconfig', {
  context: kubeConfigContext,
  kubeconfig: env.KUBECONFIG,
  suppressHelmHookWarnings: true,
  enableDryRun: true,
});

// Create namespaces.
const nsAppsDefault = new k8s.core.v1.Namespace(nsNameAppsDefault, {
  metadata: {name: nsNameAppsDefault},
}, {
  provider: kubeconfig,
});

// Deploy Podinfo Backend
const appPodinfoBackend = new k8s.helm.v3.Release('podinfo-backend', {
  name: 'podinfo-backend',
  chart: 'podinfo',
  namespace: nsNameAppsDefault,
  repositoryOpts: {repo: 'https://stefanprodan.github.io/podinfo'},
  values: {
    redis: {enabled: true},
  },
}, {
  provider: kubeconfig,
  customTimeouts: {create: '2m', update: '2m', delete: '2m'},
  dependsOn: [
    nsAppsDefault,
  ],
});

// Deploy Podinfo Frontend
const appPodinfoFrontend = new k8s.helm.v3.Release('podinfo-frontend', {
  name: 'podinfo-frontend',
  chart: 'podinfo',
  namespace: nsNameAppsDefault,
  repositoryOpts: {repo: 'https://stefanprodan.github.io/podinfo'},
  values: {
    redis: {enabled: false},
    replicaCount: 2,
    backend: pulumi.interpolate`http://podinfo-backend:9898/echo`,
    ingress: {
      enabled: true,
      className: 'default',
      annotations: {
        'konghq.com/path': '/podinfo',
        'konghq.com/protocols': 'https',
        'konghq.com/strip-path': 'true',
        'konghq.com/preserve-host': 'true',
        'konghq.com/https-redirect-status-code': '301',
        'ingress.kubernetes.io/service-upstream': 'true',
        'cert-manager.io/cluster-issuer': 'certman-selfsigned-issuer',
        'cert-manager.io/common-name': 'apps.kind.home.arpa',
        'pulumi.com/skipAwait': 'true',
      },
      hosts: [{
        host: 'apps.kind.home.arpa',
        paths: [{
          path: '/podinfo',
          pathType: 'ImplementationSpecific',
        }, {
          path: '/podinfo/*',
          pathType: 'ImplementationSpecific',
        }],
      }],
    },
  },
}, {
  provider: kubeconfig,
  customTimeouts: {create: '2m', update: '2m', delete: '2m'},
  parent: appPodinfoBackend,
  dependsOn: [
    nsAppsDefault,
    appPodinfoBackend,
  ],
});
