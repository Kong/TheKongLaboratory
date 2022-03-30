/* eslint-disable no-unused-vars */
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {env} from 'process';

// KubeConfig Context
const kubeConfigContext = 'kind-kong';

// App Namespaces
export const nsNameAppsDefault = 'keycloak';

// Export the cluster's kubeconfig.
const kubeconfig = new k8s.Provider('kubeconfig', {
  context: kubeConfigContext,
  kubeconfig: env.KUBECONFIG,
  suppressHelmHookWarnings: true,
  enableDryRun: true,
});

// Create namespaces.
const nsKeycloak = new k8s.core.v1.Namespace(nsNameAppsDefault, {
  metadata: {name: nsNameAppsDefault},
}, {
  provider: kubeconfig,
});

// Deploy Podinfo Backend
const appPodinfoBackend = new k8s.kustomize.Directory('keycloak', {
  directory: './kustomize',
  // resourcePrefix: 'tkl',
}, {
  provider: kubeconfig,
  customTimeouts: {create: '2m', update: '2m', delete: '2m'},
  dependsOn: [
    nsKeycloak,
  ],
});
