// TODO: label deployment with sha of secrets to trigger pod rotation on change
//   - ref: https://www.npmjs.com/package/shasum-object
import * as tls from '@pulumi/tls';
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as certmanager from '@pulumi/kubernetes-cert-manager';
import {env} from 'process';

interface Data {
  enterprise: boolean;
}
// Kong Configuration //
const kongConfig = new pulumi.Config('kong');

// Variables
const name = 'kong';

// KubeConfig Context
const kubeConfigContext = 'kind-kong';

// Kong Session Config
const secretKongSessionConfigSalt = 'this-is-a-random-session-config-salt';
const secretKongSessionConfigCookieSecure = false;

// Kong Admin Credentials
const kongSuperAdminPassword = 'kong_admin';

// Kong Manager Subdomain
const kongAppSubdomain = 'apps';
const kongPortalSubdomain = 'portal.kong';
const kongManagerSubdomain = 'manager.kong';
const kongBaseDomain = 'kind.home.arpa';

// Kong Admin Credentials
const kongPostgresPort = '5432';
const kongPostgresUser = 'kong';
const kongPostgresPassword = 'kong';
const kongPostgresAdminPassword = 'kong';
const kongPostgresReplicationPassword = 'kong';
const kongPostgresDatabase = 'kong';
const kongPostgresHost = 'postgres-postgresql.kong.svc.cluster.local';
const kongEnterpriseLicense = kongConfig.requireSecret('license');

// Additional Kong Ingress Controller(s) Boolean
const kongConfigEntitlement = (kongConfig.getObject<Data>('enterprise'));

// Kong plugins
const kongPlugins = 'bundled,openid-connect';
const kongLogLevel = 'debug';

// Kong Image Tags
const kongImageTag = '2.8';
const kongIngressControllerImageTag = '2.2';

// Kong Gateway Namespace
const nsNameKong = 'kong';

// Cert Manager Namespace
const nsNameCertManager = 'cert-manager';

// Postgres Image Tag
const postgresImageTag = '14.1.0';

// Export the cluster's kubeconfig.
const kubeconfig = new k8s.Provider('kubeconfig', {
  context: kubeConfigContext,
  kubeconfig: env.KUBECONFIG,
  suppressHelmHookWarnings: true,
  enableDryRun: true,
});

// Create namespaces.
const nsCertManager = new k8s.core.v1.Namespace(nsNameCertManager, {
  metadata: {name: nsNameCertManager},
}, {
  provider: kubeconfig,
});

const nsKong = new k8s.core.v1.Namespace(nsNameKong, {
  metadata: {name: nsNameKong},
}, {
  provider: kubeconfig,
});


// Deploy Certificate Manager
const manager = new certmanager.CertManager('cert-manager', {
  installCRDs: true,
  helmOptions: {
    name: 'cert-manager',
    namespace: nsNameCertManager,
    values: {
      global: {
        operatorNamespace: nsNameCertManager,
        rbac: {
          create: true,
        },
        logLevel: 'debug',
        leaderElection: {
          namespace: 'kube-system',
        },
      },
      serviceAccount: {
        create: true,
        automountServiceAccountToken: true,
      },
      securityContext: {
        runAsNonRoot: true,
      },
      webhook: {
        enabled: true,
        namespace: nsNameCertManager,
        timeoutSeconds: 30,
        serviceAccount: {
          create: true,
          automountServiceAccountToken: true,
        },
        hostNetwork: false,
        serviceType: 'ClusterIP',
      },
    },
  },
}, {
  provider: kubeconfig,
  dependsOn: nsCertManager,
});

// Create a cluster issuer that uses self-signed certificates.
// This is not very secure, but has the least amount of external
// dependencies for simplicity.
// Refer to https://cert-manager.io/docs/configuration/selfsigned/
// for additional details on other signing providers.

// Create Self Signed Root Certificate Authority.
const rootIssuer = new k8s.apiextensions.CustomResource('issuerRoot', {
  apiVersion: 'cert-manager.io/v1',
  kind: 'ClusterIssuer',
  metadata: {
    name: 'certman-clusterissuer-selfsigned-root-ca',
    namespace: nsNameCertManager,
  },
  spec: {
    selfSigned: {},
  },
}, {
  provider: kubeconfig,
  dependsOn: manager,
});

// Certificate for Self Signed ClusterIssuer.
const rootSelfSignedCa = new k8s.apiextensions.CustomResource(
    'selfSignCertificateAuthority',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: 'certman-clusterissuer-selfsigned-issuer-ca',
        namespace: nsNameCertManager,
      },
      spec: {
        isCA: true,
        commonName: 'certman-clusterissuer-selfsigned-issuer-ca',
        secretName: 'certman-clusterissuer-selfsigned-issuer-ca',
        privateKey: {
          algorithm: 'RSA',
          size: 2048,
        },
        issuerRef: {
          name: 'certman-clusterissuer-selfsigned-root-ca',
          kind: 'ClusterIssuer',
          group: 'cert-manager.io',
        },
        renewBefore: '1296000s', // 1296000 is 15 days in seconds
        durationSeconds: '31536000s', // 31536000 is 1 year in seconds
      },
    }, {
      provider: kubeconfig,
      dependsOn: rootIssuer,
    },
);

// Self Signed ClusterIssuer.
const certmanSelfsignedIssuer = new k8s.apiextensions.CustomResource(
    'selfSignIssuer',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: 'certman-selfsigned-issuer',
      },
      spec: {
        ca: {
          secretName: 'certman-clusterissuer-selfsigned-issuer-ca',
        },
      },
    }, {
      provider: kubeconfig,
      dependsOn: rootSelfSignedCa,
    },
);

// Postgresql Helm Deploy
const secretPostgresCredentials = new k8s.core.v1.Secret(
    'postgresCredentials',
    {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'kong-postgres-config',
        namespace: 'kong',
      },
      stringData: {
        'port': kongPostgresPort,
        'host': kongPostgresHost,
        'user': kongPostgresUser,
        'password': kongPostgresPassword,
        'postgres-password': kongPostgresAdminPassword,
        'replication-password': kongPostgresReplicationPassword,
        'database': kongPostgresDatabase,
      },
    }, {
      dependsOn: [
        nsKong,
      ],
      provider: kubeconfig,
    },
);

// Deploy Postgres for Kong Configuration Data Store
const kongPostgres = new k8s.helm.v3.Release('postgres', {
  name: 'postgres',
  chart: 'postgresql',
  namespace: nsNameKong,
  repositoryOpts: {repo: 'https://charts.bitnami.com/bitnami'},
  values: {
    namespace: nsNameKong,
    global: {
      storageClass: '',
      postgresql: {
        auth: {
          username: kongPostgresUser,
          database: kongPostgresDatabase,
          existingSecret: secretPostgresCredentials.metadata.name,
        },
      },
    },
    image: {
      tag: postgresImageTag,
      pullPolicy: 'IfNotPresent',
      repository: 'bitnami/postgresql',
      registry: 'docker.io',
    },
    tls: {
      enabled: true,
      autoGenerated: true,
    },
    service: {
      type: 'ClusterIP',
      port: 5432,
    },
    resources: {
      requests: {
        cpu: '250m',
        memory: '256Mi',
      },
      limits: {
        cpu: '250m',
        memory: '256Mi',
      },
    },
    persistence: {enabled: true},
    replication: {enabled: false},
    securityContext: {enabled: true},
    volumePermissions: {enabled: true},
  },
}, {
  provider: kubeconfig,
  customTimeouts: {create: '2m', update: '2m', delete: '2m'},
  dependsOn: secretPostgresCredentials,
});

// Kong API Gateway // ControlPlane

// Issue Certificate for Kong Admin Services
const kongServicesTls = new k8s.apiextensions.CustomResource(
    'kong-controlplane-services-tls',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        namespace: nsNameKong,
      },
      spec: {
        secretName: 'kong-controlplane-services-tls',
        // eslint-disable-next-line max-len
        commonName: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        dnsNames: [
          pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        ],
        renewBefore: '360h',
        duration: '2160h',
        isCa: false,
        issuerRef: {
          name: 'certman-selfsigned-issuer',
          kind: 'ClusterIssuer',
        },
      },
    }, {
      provider: kubeconfig,
      dependsOn: certmanSelfsignedIssuer,
    },
);

// Issue Certificate for Kong Admin Services
// eslint-disable-next-line no-unused-vars
const kongAppsTls = new k8s.apiextensions.CustomResource(
    'kong-proxy-tls',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: pulumi.interpolate`apps.${kongBaseDomain}`,
        namespace: nsNameKong,
      },
      spec: {
        secretName: 'kong-proxy-tls',
        commonName: pulumi.interpolate`${kongBaseDomain}`,
        dnsNames: [
          pulumi.interpolate`${kongBaseDomain}`,
          pulumi.interpolate`*.${kongBaseDomain}`,
          pulumi.interpolate`${kongAppSubdomain}.${kongBaseDomain}`,
          pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
        ],
        renewBefore: '360h',
        duration: '2160h',
        isCa: false,
        issuerRef: {
          name: 'certman-selfsigned-issuer',
          kind: 'ClusterIssuer',
        },
      },
    }, {
      provider: kubeconfig,
      dependsOn: certmanSelfsignedIssuer,
    },
);

// // Issue certificate for kong cluster mtls
const kongClusterKey = new tls.PrivateKey(`${name}-cluster-mtls-pkey`, {
  algorithm: 'RSA',
  rsaBits: 2048,
});

const kongClusterCert = new tls.SelfSignedCert(`${name}-cluster-mtls-cert`, {
  privateKeyPem: kongClusterKey.privateKeyPem,
  allowedUses: [
    'serverAuth',
  ],
  keyAlgorithm: kongClusterKey.algorithm,
  subjects: [{commonName: 'kong_clustering'}],
  dnsNames: ['kong_clustering'],
  validityPeriodHours: 4870,
  isCaCertificate: false,
}, {
  parent: kongClusterKey,
});

// TODO: Consider Rotation Strategy
const secretKongClusterCert = new k8s.core.v1.Secret(`${name}-cluster-cert`, {
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'tls',
  metadata: {
    name: 'kong-cluster-cert',
    namespace: 'kong',
  },
  stringData: {
    'tls.crt': kongClusterCert.certPem,
    'tls.key': kongClusterKey.privateKeyPem,
  },
}, {
  dependsOn: [
    nsKong,
  ],
  parent: kongClusterCert,
  provider: kubeconfig,
});

// Create Kong Enterprise License Secret // TODO: deployment label based pod rotation https://www.npmjs.com/package/shasum-object (for sha256)
const secretKongEnterpriseLicense = new k8s.core.v1.Secret(
    'kong-enterprise-license',
    {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'kong-enterprise-license',
        namespace: nsNameKong,
      },
      stringData: {
        'license': kongEnterpriseLicense,
      },
    }, {
      provider: kubeconfig,
      dependsOn: [
        nsKong,
      ],
    },
);

// Create client session config secret
const portalSessionConfData = pulumi.interpolate`{
    "storage":"kong",
    "secret":"${secretKongSessionConfigSalt}",
    "cookie_name":"admin_session",
    "cookie_samesite":"off",
    "cookie_secure":${secretKongSessionConfigCookieSecure}
}`;
const adminGuiSessionConfData = pulumi.interpolate`{
    "storage": "kong",
    "secret": "${secretKongSessionConfigSalt}",
    "cookie_name": "portal_session",
    "cookie_samesite":"off",
    "cookie_secure":${secretKongSessionConfigCookieSecure}
}`;
const secretKongSessionConfig = new k8s.core.v1.Secret('kong-session-config', {
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: {
    name: 'kong-session-config',
    namespace: nsNameKong,
  },
  stringData: {
    'portal_session_conf': portalSessionConfData,
    'admin_gui_session_conf': adminGuiSessionConfData,
  },
}, {
  provider: kubeconfig,
  dependsOn: [
    nsKong,
  ],
});

// Kong Super Admin Credentials
const secretKongSuperAdminCredentials = new k8s.core.v1.Secret(
    'kong-enterprise-superuser-password',
    {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'kong-enterprise-superuser-password',
        namespace: nsNameKong,
      },
      stringData: {
        password: kongSuperAdminPassword,
      },
    }, {
      dependsOn: [
        nsKong,
      ],
      provider: kubeconfig,
    },
);

// Helm Kong Integrated Deploy
const kongControlPlane = new k8s.helm.v3.Release('controlplane', {
  name: 'controlplane',
  chart: 'kong',
  namespace: nsNameKong,
  repositoryOpts: {repo: 'https://charts.konghq.com/'},
  values: {
    namespace: nsNameKong,
    admin: {
      annotations: {
        'konghq.com/protocol': 'https',
      },
      enabled: true,
      http: {
        enabled: false,
      },
      ingress: {
        annotations: {
          'kubernetes.io/ingress.class': 'default',
          'konghq.com/protocols': 'https',
          'konghq.com/strip-path': 'true',
          'konghq.com/https-redirect-status-code': '301',
          'nginx.ingress.kubernetes.io/app-root': '/',
          'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS',
          'nginx.ingress.kubernetes.io/permanent-redirect-code': '301',
        },
        enabled: true,
        hostname: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        path: '/api',
        tls: 'kong-controlplane-services-tls',
      },
      tls: {
        containerPort: 8444,
        enabled: true,
        parameters: [
          'http2',
        ],
        servicePort: 8444,
      },
      type: 'ClusterIP',
    },
    cluster: {
      enabled: true,
      type: 'ClusterIP',
      labels: {
        'konghq.com/service': 'cluster',
      },
      tls: {
        containerPort: 8005,
        enabled: true,
        servicePort: 8005,
      },
    },
    clustertelemetry: {
      enabled: true,
      tls: {
        containerPort: 8006,
        enabled: true,
        servicePort: 8006,
        type: 'ClusterIP',
      },
    },
    deployment: {
      kong: {
        daemonset: false,
        enabled: true,
      },
    },
    enterprise: {
      enabled: true,
      license_secret: 'kong-enterprise-license',
      portal: {
        enabled: true,
      },
      rbac: {
        enabled: kongEnterpriseLicense,
        admin_api_auth: 'basic-auth',
        admin_gui_auth_conf_secret: 'kong-session-config',
        session_conf_secret: 'kong-session-config',
      },
      smtp: {
        enabled: false,
      },
      vitals: {
        enabled: true,
      },
    },
    env: {
      role: 'control_plane',
      plugins: pulumi.interpolate`${kongPlugins}`,
      log_level: kongLogLevel,
      password: {
        valueFrom: {
          secretKeyRef: {
            name: 'kong-enterprise-superuser-password',
            key: 'password',
          },
        },
      },
      trusted_ips: '0.0.0.0/0,::/0',
      status_listen: '0.0.0.0:8100',
      cluster_listen: '0.0.0.0:8005',
      cluster_telemetry_listen: '0.0.0.0:8006',
      cluster_data_plane_purge_delay: 60,
      proxy_stream_access_log: '/dev/stdout',
      proxy_stream_error_log: '/dev/stdout',
      lua_package_path: '/opt/?.lua;;',
      // eslint-disable-next-line max-len
      lua_ssl_trusted_certificate: '/etc/secrets/kong-cluster-cert/tls.crt,/etc/ssl/certs/ca-certificates.crt',
      proxy_access_log: '/dev/stdout',
      proxy_error_log: '/dev/stdout',
      nginx_worker_processes: '2',
      prefix: '/kong_prefix/',
      smtp_mock: 'on',
      vitals: true,

      // START Kong Portal Configuration //
      portal: true,
      portal_api_error_log: '/dev/stdout',
      portal_api_access_log: '/dev/stdout',
      portal_api_uri: pulumi.interpolate`https://${kongPortalSubdomain}.${kongBaseDomain}/api`,
      portal_auth: 'basic-auth',
      portal_cors_origins: '*',
      portal_gui_access_log: '/dev/stdout',
      portal_gui_error_log: '/dev/stdout',
      // eslint-disable-next-line max-len
      portal_gui_host: pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
      portal_gui_protocol: 'https',
      portal_gui_url: pulumi.interpolate`https://${kongPortalSubdomain}.${kongBaseDomain}/`,
      portal_session_conf: {
        valueFrom: {
          secretKeyRef: {
            key: 'portal_session_conf',
            name: 'kong-session-config',
          },
        },
      },
      // STOP Kong Portal Configuration //

      // START Database Configuration //
      pg_port: {
        valueFrom: {
          secretKeyRef: {
            name: secretPostgresCredentials.metadata.name,
            key: 'port',
          },
        },
      },
      pg_user: {
        valueFrom: {
          secretKeyRef: {
            name: secretPostgresCredentials.metadata.name,
            key: 'user',
          },
        },
      },
      pg_database: {
        valueFrom: {
          secretKeyRef: {
            name: secretPostgresCredentials.metadata.name,
            key: 'database',
          },
        },
      },
      pg_password: {
        valueFrom: {
          secretKeyRef: {
            name: secretPostgresCredentials.metadata.name,
            key: 'password',
          },
        },
      },
      pg_host: {
        valueFrom: {
          secretKeyRef: {
            name: secretPostgresCredentials.metadata.name,
            key: 'host',
          },
        },
      },
      database: 'postgres',
      // WARN: database ssl verification disabled not recommended for production
      pg_ssl_verify: 'off',
      // WARN: database SSL disabled on DB, do not use this mode in production
      pg_ssl: 'off',
      // END Database Configuration //

      // START Admin API Configuration //
      admin_api_uri: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/api`,
      admin_ssl_cert_key: '/etc/secrets/kong-controlplane-services-tls/tls.key',
      admin_ssl_cert: '/etc/secrets/kong-controlplane-services-tls/tls.crt',
      admin_access_log: '/dev/stdout',
      admin_error_log: '/dev/stdout',
      // END Admin API Configuration //

      // START Admin GUI Configuration //
      admin_gui_access_log: '/dev/stdout',
      admin_gui_error_log: '/dev/stdout',
      // eslint-disable-next-line max-len
      admin_gui_host: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
      admin_gui_protocol: 'https',
      admin_gui_ssl_cert: '/etc/secrets/kong-controlplane-services-tls/tls.crt',
      // eslint-disable-next-line max-len
      admin_gui_ssl_cert_key: '/etc/secrets/kong-controlplane-services-tls/tls.key',
      admin_gui_url: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/`,
      // END Admin GUI Configuration //

      // // START Proxy Configuration //
      ssl_cert: '/etc/secrets/kong-proxy-tls/tls.crt',
      ssl_cert_key: '/etc/secrets/kong-proxy-tls/tls.key',
      // // END Proxy Configuration //

      // // START Cluster MTLS Configuration //
      cluster_cert: '/etc/secrets/kong-cluster-cert/tls.crt',
      cluster_cert_key: '/etc/secrets/kong-cluster-cert/tls.key',
      // // END Cluster MTLS Configuration //
    },
    image: {
      repository: 'kong/kong-gateway',
      tag: kongImageTag,
    },
    ingressController: {
      enabled: false,
      installCRDs: false,
    },
    manager: {
      enabled: true,
      annotations: {
        'konghq.com/protocol': 'https',
      },
      ingress: {
        enabled: true,
        annotations: {
          'kubernetes.io/ingress.class': 'default',
          'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS',
        },
        hostname: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        tls: 'kong-controlplane-services-tls',
        path: '/',
      },
      http: {
        containerPort: 8002,
        enabled: false,
        servicePort: 8002,
      },
      tls: {
        containerPort: 8445,
        enabled: true,
        parameters: [
          'http2',
        ],
        servicePort: 8445,
      },
      type: 'ClusterIP',
    },
    portal: {
      annotations: {
        'konghq.com/protocol': 'https',
      },
      enabled: true,
      http: {
        containerPort: 8003,
        enabled: false,
        servicePort: 8003,
      },
      ingress: {
        annotations: {
          'kubernetes.io/ingress.class': 'public',
          'konghq.com/protocols': 'https',
          'konghq.com/strip-path': 'false',
          'konghq.com/https-redirect-status-code': '301',
        },
        enabled: true,
        hostname: pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
        path: '/',
        tls: 'kong-proxy-tls',
      },
      tls: {
        containerPort: 8446,
        enabled: true,
        parameters: [
          'http2',
        ],
        servicePort: 8446,
      },
      type: 'ClusterIP',
    },
    portalapi: {
      annotations: {
        'konghq.com/protocol': 'https',
      },
      enabled: true,
      http: {
        enabled: false,
      },
      ingress: {
        annotations: {
          'kubernetes.io/ingress.class': 'public',
          'konghq.com/protocols': 'https',
          'konghq.com/strip-path': 'true',
          'konghq.com/https-redirect-status-code': '301',
          'nginx.ingress.kubernetes.io/app-root': '/',
        },
        enabled: true,
        hostname: pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
        path: '/api',
        tls: 'kong-proxy-tls',
      },
      tls: {
        containerPort: 8447,
        enabled: true,
        parameters: [
          'http2',
        ],
        servicePort: 8447,
      },
      type: 'ClusterIP',
    },
    proxy: {
      enabled: false,
    },
    replicaCount: 1,
    secretVolumes: [
      'kong-controlplane-services-tls',
      'kong-cluster-cert',
      'kong-proxy-tls',
    ],
    status: {
      enabled: true,
      http: {
        containerPort: 8100,
        enabled: true,
      },
      tls: {
        containerPort: 8543,
        enabled: false,
      },
    },
    migrations: {
      enabled: true,
      preUpgrade: true,
      postUpgrade: true,
    },
    extraLabels: {
      'konghq.com/component': 'controlplane',
    },
    podAnnotations: {
      'kuma.io/gateway': 'enabled',
    },
  },
}, {
  dependsOn: [
    kongPostgres,
    kongServicesTls,
    kongClusterCert,
    secretKongClusterCert,
    secretKongSessionConfig,
    secretKongEnterpriseLicense,
    secretKongSuperAdminCredentials,
  ],
  customTimeouts: {
    create: '1m',
    update: '1m',
    delete: '1m',
  },
  provider: kubeconfig,
});

// Kong Dataplane //
const kongDataPlane = new k8s.helm.v3.Release(
    'dataplane',
    {
      name: 'dataplane',
      chart: 'kong',
      skipCrds: true,
      namespace: nsNameKong,
      repositoryOpts: {repo: 'https://charts.konghq.com/'},
      values: {
        admin: {enabled: false},
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              {
                podAffinityTerm: {
                  labelSelector: {
                    matchExpressions: [
                      {
                        key: 'app.kubernetes.io/instance',
                        operator: 'In',
                        values: [
                          'dataplane',
                        ],
                      },
                    ],
                  },
                  topologyKey: 'kubernetes.io/hostname',
                },
                weight: 100,
              },
            ],
          },
        },
        cluster: {enabled: false},
        deployment: {
          kong: {
            daemonset: false,
            enabled: true,
          },
        },
        enterprise: {
          enabled: true,
          license_secret: 'kong-enterprise-license',
        },
        env: {
          cluster_cert: '/etc/secrets/kong-cluster-cert/tls.crt',
          cluster_cert_key: '/etc/secrets/kong-cluster-cert/tls.key',
          // TODO: variablize controlplane-kong-cluster dns name
          // eslint-disable-next-line max-len
          cluster_control_plane: 'controlplane-kong-cluster.kong.svc.cluster.local:8005',
          // TODO: variablize controlplane-kong-clustertelemetry
          // eslint-disable-next-line max-len
          cluster_telemetry_endpoint: 'controlplane-kong-clustertelemetry.kong.svc.cluster.local:8006',
          ssl_cert_key: '/etc/secrets/kong-controlplane-services-tls/tls.key',
          ssl_cert: '/etc/secrets/kong-controlplane-services-tls/tls.crt',
          database: 'off',
          log_level: kongLogLevel,
          lua_package_path: '/opt/?.lua;;',
          // eslint-disable-next-line max-len
          lua_ssl_trusted_certificate: '/etc/secrets/kong-cluster-cert/tls.crt,/etc/ssl/certs/ca-certificates.crt',
          nginx_worker_processes: '2',
          plugins: pulumi.interpolate`${kongPlugins}`,
          prefix: '/kong_prefix/',
          proxy_access_log: '/dev/stdout',
          proxy_error_log: '/dev/stdout',
          proxy_stream_error_log: '/dev/stdout',
          proxy_stream_access_log: '/dev/stdout',
          status_error_log: '/dev/stdout',
          role: 'data_plane',
        },
        image: {
          repository: 'kong/kong-gateway',
          tag: kongImageTag,
        },
        ingressController: {enabled: false, installCRDs: false},
        manager: {enabled: false},
        migrations: {preUpgrade: false, postUpgrade: false},
        namespace: nsNameKong,
        portal: {enabled: false},
        portalapi: {enabled: false},
        proxy: {
          enabled: true,
          annotations: {
            'prometheus.io/port': '9542',
            'prometheus.io/scrape': 'true',
          },
          http: {
            containerPort: 8080,
            enabled: true,
            hostPort: 80,
          },
          ingress: {enabled: false},
          labels: {
            'enable-metrics': true,
          },
          tls: {
            containerPort: 8443,
            enabled: true,
            hostPort: 443,
          },
          type: 'ClusterIP',
        },
        replicaCount: 1,
        secretVolumes: [
          'kong-controlplane-services-tls',
          'kong-proxy-tls',
          'kong-cluster-cert',
        ],
      },
    },
    {
      provider: kubeconfig,
      parent: kongControlPlane,
      dependsOn: [
        kongPostgres,
        kongControlPlane,
        kongClusterCert,
        kongServicesTls,
      ],
      customTimeouts: {
        create: '1m',
        update: '1m',
        delete: '1m',
      },
    },
);

// Kong Ingress Controller - Ingress Class Default //
// eslint-disable-next-line no-unused-vars
const kongIngressControllerDefault = new k8s.helm.v3.Release(
    'ingress-controller-default',
    {
      name: 'controller-default',
      chart: 'kong',
      skipCrds: true,
      namespace: nsNameKong,
      repositoryOpts: {repo: 'https://charts.konghq.com/'},
      values: {
        deployment: {
          kong: {
            enabled: false,
          },
        },
        ingressController: {
          enabled: true,
          installCRDs: false,
          ingressClass: 'default',
          watchNamespaces: [],
          env: {
            kong_admin_token: {
              valueFrom: {
                secretKeyRef: {
                  key: 'password',
                  name: 'kong-enterprise-superuser-password',
                },
              },
            },
            kong_admin_tls_skip_verify: true,
            kong_workspace: 'default',
            kong_admin_url: 'https://controlplane-kong-admin.kong.svc.cluster.local:8444',
            publish_service: 'kong/dataplane-kong-proxy',
            kong_admin_filter_tag: 'ingress_class_default',
          },
          image: {
            repository: 'docker.io/kong/kubernetes-ingress-controller',
            tag: kongIngressControllerImageTag,
          },
        },
      },
    },
    {
      provider: kubeconfig,
      parent: kongControlPlane,
      dependsOn: [
        kongPostgres,
        kongDataPlane,
        kongControlPlane,
        kongClusterCert,
        kongServicesTls,
      ],
      customTimeouts: {
        create: '1m',
        update: '1m',
        delete: '1m',
      },
    },
);

// Kong Entitlements //
if (kongConfigEntitlement) {
  // Kong Ingress Controller - Ingress Class Public //
  // eslint-disable-next-line no-unused-vars
  const kongIngressControllerPublic = new k8s.helm.v3.Release(
      'ingress-controller-public',
      {
        name: 'controller-public',
        chart: 'kong',
        skipCrds: true,
        namespace: nsNameKong,
        repositoryOpts: {repo: 'https://charts.konghq.com/'},
        values: {
          deployment: {
            kong: {
              enabled: false,
            },
          },
          ingressController: {
            enabled: true,
            installCRDs: false,
            ingressClass: 'public',
            watchNamespaces: [],
            env: {
              kong_workspace: 'public',
              kong_admin_filter_tag: 'ingress_class_public',
              kong_admin_token: {
                valueFrom: {
                  secretKeyRef: {
                    key: 'password',
                    name: 'kong-enterprise-superuser-password',
                  },
                },
              },
              kong_admin_tls_skip_verify: true,
              kong_admin_url: 'https://controlplane-kong-admin.kong.svc.cluster.local:8444',
              publish_service: 'kong/dataplane-kong-proxy',
            },
            image: {
              repository: 'docker.io/kong/kubernetes-ingress-controller',
              tag: kongIngressControllerImageTag,
            },
          },
        },
      },
      {
        provider: kubeconfig,
        parent: kongControlPlane,
        dependsOn: [
          kongPostgres,
          kongDataPlane,
          kongControlPlane,
          kongClusterCert,
          kongServicesTls,
        ],
        customTimeouts: {
          create: '1m',
          update: '1m',
          delete: '1m',
        },
      },
  );
} else {
  // Else do not create 'Public' Ingress Controller //
  ;
};

export const certManagerStatus = manager.status;
