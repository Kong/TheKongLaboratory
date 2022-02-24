import * as tls from "@pulumi/tls";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as certmanager from "@pulumi/kubernetes-cert-manager";
import { env } from "process";

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Variables
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
const name = "kong";

// KubeConfig Context
const kubeConfigContext = "kind-kongpulumilabs";

// Kong Admin Credentials
const kongSuperAdminPassword = "kong_admin";

// Kong Manager Subdomain
const kongAppSubdomain = "apps";
const kongPortalSubdomain = "portal.kong";
const kongManagerSubdomain = "manager.kong";
const kongBaseDomain = "kongpulumilabs.arpa";

// Kong Admin Credentials
const kongPostgresUser = "kong";
const kongPostgresPassword = "kong";
const kongPostgresDatabase = "kong";
const kongPostgresHost = "postgres-postgresql.kong.svc.cluster.local";
const kongPostgresPort = "5432";

// Kong plugins
const kongPlugins = "bundled";
const kongLogLevel = "debug";

// Kong Image Tag
const kongImageTag = "2.7";

// Kong Gateway Namespace
const nsNameKong = "kong";

// Cert Manager Namespace
const nsNameCertManager = "cert-manager";

// Postgres Image Tag
const postgresImageTag = "14.1.0";

// Export the cluster's kubeconfig.
const kubeconfig = new k8s.Provider("kubeconfig", {
    context: kubeConfigContext,
    kubeconfig: env.KUBECONFIG,
    suppressHelmHookWarnings: true,
    enableDryRun: true,
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Create namespaces.
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


const nsCertManager = new k8s.core.v1.Namespace(nsNameCertManager, {
    metadata: { name: nsNameCertManager },
},{
    provider: kubeconfig,
});

const nsKong = new k8s.core.v1.Namespace(nsNameKong, {
    metadata: { name: nsNameKong },
},{
    provider: kubeconfig
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Deploy Certificate Manager
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Install cert-manager into cluster.
const manager = new certmanager.CertManager("cert-manager", {
    installCRDs: true,
    helmOptions: {
        name: "cert-manager",
        namespace: nsNameCertManager,
        values: {
            global: {
                operatorNamespace: nsNameCertManager,
                rbac: {
                    create: true,
                },
                logLevel: "debug",
                leaderElection: {
                    namespace: "kube-system",
                }
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
                serviceType: "ClusterIP",
            },
        },
    },
},{
    provider: kubeconfig,
    dependsOn: nsCertManager,
});

// Create a cluster issuer that uses self-signed certificates.
// This is not very secure, but has the least amount of external
// dependencies, so is simple. Please refer to
// https://cert-manager.io/docs/configuration/selfsigned/
// for additional details on other signing providers.

// Create Self Signed Root Certificate Authority.
const rootIssuer = new k8s.apiextensions.CustomResource("issuerRoot", {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: {
        name: "certman-clusterissuer-selfsigned-issuer",
        namespace: nsNameCertManager,
    },
    spec: {
        selfSigned: {},
    },
},{
    provider: kubeconfig,
    dependsOn: manager,
});

// Certificate for Self Signed ClusterIssuer.
const rootSelfSignedCa = new k8s.apiextensions.CustomResource("selfSignCertificateAuthority", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "certman-clusterissuer-selfsigned-issuer-ca",
        namespace: nsNameCertManager,
    },
    spec: {
        commonName: "certman-clusterissuer-selfsigned-issuer-ca",
        secretName: "certman-clusterissuer-selfsigned-issuer-ca",
        privateKey: {
            algorithm: "ECDSA",
            size: 256, // supported values: 256, 384, 521
        },
        issuerRef: {
            name: "certman-clusterissuer-selfsigned-issuer",
            kind: "ClusterIssuer",
            group: "cert-manager.io",
        },
        renewBefore: "1296000s", // 1296000 is 15 days in seconds
        durationSeconds: "31536000s", // 31536000 is 1 year in seconds
        isCA: true,
    },
},{
    provider: kubeconfig,
    dependsOn: rootIssuer,
});

// Self Signed ClusterIssuer.
const certmanSelfsignedIssuer = new k8s.apiextensions.CustomResource("selfSignIssuer", {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: {
        name: "certman-selfsigned-issuer",
    },
    spec: {
        ca: {
            secretName: "certman-clusterissuer-selfsigned-issuer-ca",
        },
    },
},{
    provider: kubeconfig,
    dependsOn: rootSelfSignedCa,
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Postgresql Helm Deploy
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const secretPostgresCredentials = new k8s.core.v1.Secret("postgresCredentials", {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
        name: "kong-postgres-config",
        namespace: "kong",
    },
    stringData: {
        //pg_user: kongPostgresUser,
        //pg_password: kongPostgresPassword,
        //pg_database: kongPostgresDatabase,
        //pg_host: kongPostgresHost,
        //pg_port: kongPostgresPort,
        pg_user: Buffer.from(kongPostgresUser).toString("base64"),
        pg_password: Buffer.from(kongPostgresPassword).toString("base64"),
        pg_database: Buffer.from(kongPostgresDatabase).toString("base64"),
        pg_host: Buffer.from(kongPostgresHost).toString("base64"),
        pg_port: Buffer.from(kongPostgresPort).toString("base64"),
    },
}, {
    dependsOn: [
        nsKong,
    ],
    provider: kubeconfig,
});

const kongPostgres = new k8s.helm.v3.Release("postgres", {
    name: "postgres",
    chart: "postgresql",
    namespace: nsNameKong,
    repositoryOpts: { repo: "https://charts.bitnami.com/bitnami" },
    values: {
        namespace: nsNameKong,
        global: {
            storageClass: "",
            postgresql: {
                auth: {
                    username: {
                        valueFrom: {
                            secretKeyRef: {
                                name: "kong-postgres-config",
                                key: "pg_user",
                            },
                        },
                    },
                    password: {
                        valueFrom: {
                            secretKeyRef: {
                                name: "kong-postgres-config",
                                key: "pg_password",
                            },
                        },
                    },
                    database: {
                        valueFrom: {
                            secretKeyRef: {
                                name: "kong-postgres-config",
                                key: "pg_database",
                            },
                        },
                    },
                    postgresPassword: {
                        valueFrom: {
                            secretKeyRef: {
                                name: "kong-postgres-config",
                                key: "pg_password",
                            },
                        },
                    },
                },
            },
        },
        image: {
            tag: postgresImageTag,
            pullPolicy: "IfNotPresent",
            repository: "bitnami/postgresql",
            registry: "docker.io",
        },
        tls: {
            enabled: true,
            autoGenerated: true,
        },
        service: {
            type: "ClusterIP",
            port: 5432,
        },
        resources: {
            requests: {
                cpu: "250m",
                memory: "256Mi",
            },
            limits: {
                cpu: "250m",
                memory: "256Mi",
            },
        },
        persistence: { enabled: true },
        replication: { enabled: false },
        securityContext: { enabled: true },
        volumePermissions: { enabled: true },
    },
},{
    provider: kubeconfig,
    customTimeouts: {create: "2m", update: "2m", delete: "2m"},
    dependsOn: secretPostgresCredentials,
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Kong API Gateway // ControlPlane
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Issue certificate for kong api
const kongServicesTls = new k8s.apiextensions.CustomResource("kong-controlplane-services-tls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "kong-controlplane-services-tls",
        namespace: nsNameKong,
    },
    spec: {
        secretName: "kong-controlplane-services-tls",
        issuerRef: {
            name: "certman-selfsigned-issuer",
            kind: "ClusterIssuer",
        },
        commonName: pulumi.interpolate`${kongBaseDomain}`,
        dnsNames: [
            pulumi.interpolate`*.${kongBaseDomain}`,
            pulumi.interpolate`proxy.${kongBaseDomain}`,
            pulumi.interpolate`${kongAppSubdomain}.${kongBaseDomain}`,
            pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
        ],
        renewBefore: "360h",
        duration: "8760h",
        isCa: false,
    },
},{
    provider: kubeconfig,
    dependsOn: certmanSelfsignedIssuer,
});

// TODO: Activate Cluster MTLS Certificate
//// Issue certificate for kong cluster mtls
const kongClusterKey = new tls.PrivateKey(`${name}-cluster-mtls-pkey`, {
  algorithm: "RSA",
  rsaBits: 2048,
});

const kongClusterCert = new tls.SelfSignedCert(`${name}-cluster-mtls-cert`, {
  privateKeyPem: kongClusterKey.privateKeyPem,
  allowedUses: [
    "keyEncipherment",
    "digitalSignature",
    "serverAuth",
    "cert_signing",
    "crl_signing",
  ],
  keyAlgorithm: kongClusterKey.algorithm,
  subjects: [{ commonName: 'kong_clustering' }],
  dnsNames: ['kong_clustering'],
  validityPeriodHours: 4870,
  isCaCertificate: false,
},{
    parent: kongClusterKey,
});

// TODO: Consider Rotation Strategy
const secretKongClusterCert = new k8s.core.v1.Secret(`${name}-cluster-cert`, {
    apiVersion: "v1",
    kind: "Secret",
    type: "tls",
    metadata: {
        name: "kong-kong-cluster",
        namespace: "kong",
    },
    stringData: {
        "tls.crt": kongClusterCert.certPem,
        "tls.key": kongClusterCert.privateKeyPem,
        //"tls.crt": kongClusterCert.certPem,
        //"tls.key": kongClusterCert.privateKeyPem,
    },
}, {
    dependsOn: [
        nsKong,
    ],
    parent: kongClusterCert,
    provider: kubeconfig,
});

// Kong Super Admin Credentials
const secretKongSuperAdminCredentials = new k8s.core.v1.Secret("kong-enterprise-superuser-password", {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
        name: "kong-enterprise-superuser-password",
        namespace: "kong",
    },
    data: {
        password: Buffer.from(kongSuperAdminPassword).toString("base64"),
    },
}, {
    dependsOn: [
        nsKong,
    ],
    provider: kubeconfig,
});

// Helm Kong Integrated Deploy
const kongControlPlane = new k8s.helm.v3.Release("controlplane", {
    name: "controlplane",
    chart: "kong",
    namespace: nsNameKong,
    repositoryOpts: { repo: "https://charts.konghq.com/" },
    values: {
        namespace: nsNameKong,
        admin: {
            annotations: {
                "konghq.com/protocol": "https",
            },
            enabled: true,
            ingress: {
                annotations: {
                    "konghq.com/protocols": "https",
                    "konghq.com/strip-path": "true",
                    "konghq.com/https-redirect-status-code": "301",
                },
                enabled: true,
                hostname: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
                path: "/api",
                tls: "kong-controlplane-services-tls",
                ingresClass: "kong",
            },
            tls: {
                containerPort: 8444,
                enabled: true,
                parameters: [
                    "http2",
                ],
                servicePort: 8444,
            },
            type: "ClusterIP",
        },
        cluster: {
            enabled: true,
            type: "ClusterIP",
            labels: {
                "konghq.com/service": "cluster",
            },
            tls: {
                containerPort: 8005,
                enabled: true,
                servicePort: 8005,
            },
        },
        clusterTelemetry: {
            enabled: true,
            tls: {
                containerPort: 8006,
                enabled: true,
                servicePort: 8006,
                type: "ClusterIP",
            }
        },
        deployment: {
            kong: {
                daemonset: false,
                enabled: true,
            },
        },
        enterprise: {
            enabled: true,
            license_secret: "kong-enterprise-license",
            portal: {
                enabled: true,
            },
            rbac: {
                admin_api_auth: "basic-auth",
                admin_gui_auth_conf_secret: "kong-session-config",
                enabled: true,
                session_conf_secret: "kong-session-config",
            },
            smtp: {
                enabled: false,
            },
            vitals: {
                enabled: false,
            },
        },
        env: {
            role: "control_plane",
            //plugins: pulumi.interpolate`"${kongPlugins}"`, // TODO: solve for plugin list syntax
            log_level: kongLogLevel,
            password: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-enterprise-superuser-password",
                        key: "password",
                    },
                },
            },
            trusted_ips: "0.0.0.0/0,::/0",
            status_listen: "0.0.0.0:8100",
            cluster_listen: "0.0.0.0:8005",
            cluster_telemetry_listen: "0.0.0.0:8006",
            cluster_data_plane_purge_delay: 60,
            proxy_stream_access_log: "/dev/stdout",
            proxy_stream_error_log: "/dev/stdout",
            lua_package_path: "/opt/?.lua;;",
            lua_ssl_trusted_certificate: "/etc/secrets/kong-cluster-cert/tls.crt,/etc/ssl/certs/ca-certificates.crt",
            proxy_access_log: "/dev/stdout",
            proxy_error_log: "/dev/stdout",
            nginx_worker_processes: "2",
            prefix: "/kong_prefix/",
            smtp_mock: "off",
            vitals: true,

            // START Kong Portal Configuration //
            portal: true,
            portal_api_error_log: "/dev/stdout",
            portal_api_access_log: "/dev/stdout",
            portal_api_uri: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/api`,
            portal_auth: "basic-auth",
            portal_cors_origins: '*',
            portal_gui_access_log: "/dev/stdout",
            portal_gui_error_log: "/dev/stdout",
            portal_gui_host: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
            portal_gui_protocol: "https",
            portal_gui_url: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/`,
            portal_session_conf: {
              valueFrom: {
                secretKeyRef: {
                  key: "portal_session_conf",
                  name: "kong-session-config",
                },
              },
            },
            // STOP Kong Portal Configuration //

            // START Database Configuration //
            pg_port: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-postgres-config",
                        key: "pg_port",
                    },
                },
            },
            pg_user: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-postgres-config",
                        key: "pg_user",
                    },
                },
            },
            pg_database: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-postgres-config",
                        key: "pg_database",
                    },
                },
            },
            pg_password: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-postgres-config",
                        key: "pg_password",
                    },
                },
            },
            pg_host: {
                valueFrom: {
                    secretKeyRef: {
                        name: "kong-postgres-config",
                        key: "pg_host",
                    },
                },
            },
            database: "postgres",
            pg_ssl_verify: "off", // WARN: database ssl verification disabled, not recommended for production
            pg_ssl: "off", // WARN: database SSL disabled on DB, do not use this mode in production
            // END Database Configuration //

            // START Admin API Configuration //
            admin_api_uri: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/api`,
            admin_ssl_cert_key: "/etc/secrets/kong-controlplane-services-tls/tls.key",
            admin_ssl_cert: "/etc/secrets/kong-controlplane-services-tls/tls.crt",
            admin_access_log: "/dev/stdout",
            admin_error_log: "/dev/stdout",
            // END Admin API Configuration //

            // START Admin GUI Configuration //
            admin_gui_access_log: "/dev/stdout",
            admin_gui_error_log: "/dev/stdout",
            admin_gui_host: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
            admin_gui_protocol: "https",
            admin_gui_ssl_cert: "/etc/secrets/kong-controlplane-services-tls/tls.crt",
            admin_gui_ssl_cert_key: "/etc/secrets/kong-controlplane-services-tls/tls.key",
            admin_gui_url: pulumi.interpolate`https://${kongManagerSubdomain}.${kongBaseDomain}/`,
            // END Admin GUI Configuration //

            //// START Proxy Configuration //
            //ssl_cert: "/etc/secrets/kong-controlplane-services-tls/tls.crt",
            //ssl_cert_key: "/etc/secrets/kong-controlplane-services-tls/tls.key",
            //// END Proxy Configuration //

            // TODO: Activate Cluster MTLS Certificate
            //// START Cluster MTLS Configuration //
            cluster_cert: "/etc/secrets/kong-cluster-cert/tls.crt",
            cluster_cert_key: "/etc/secrets/kong-cluster-cert/tls.key",
            //// END Cluster MTLS Configuration //
        },
        image: {
            repository: "docker.io/kong/kong-gateway",
            tag: kongImageTag,
        },
        ingressController: {
            enabled: true,
            installCRDs: false,
            env: {
                kong_admin_tls_skip_verify: true,
                kong_admin_token: {
                    valueFrom: {
                        secretKeyRef: {
                            key: "password",
                            name: "kong-enterprise-superuser-password",
                        },
                    },
                },
                publish_service: "kong/dataplane-kong-proxy",
            },
        },
        manager: {
            enabled: true,
            annotations: {
                "konghq.com/protocol": "https",
            },
            ingress: {
                enabled: true,
                ingressClass: "kong",
                hostname: pulumi.interpolate`${kongManagerSubdomain}.${kongBaseDomain}`,
                tls: "kong-controlplane-services-tls",
                path: "/",
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
                    "http2"
                ],
                servicePort: 8445,
            },
            type: "ClusterIP",
        },
        portal: {
            annotations: {
                "konghq.com/protocol": "https",
            },
            enabled: true,
            http: {
                containerPort: 8003,
                enabled: false,
                servicePort: 8003,
            },
            ingress: {
                enabled: true,
                ingressClass: "kong",
                annotations: {
                    "konghq.com/https-redirect-status-code": "301",
                    "konghq.com/protocols": "https",
                    "konghq.com/strip-path": "true",
                },
                hostname: pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
                path: "/",
                tls: "kong-controlplane-services-tls",
            },
            tls: {
                containerPort: 8446,
                enabled: true,
                parameters: [
                    "http2",
                ],
                servicePort: 8446,
            },
            type: "ClusterIP",
        },
        portalapi: {
            annotations: {
                "konghq.com/protocol": "https",
            },
            enabled: true,
            http: {
                enabled: false,
            },
            ingress: {
                enabled: true,
                ingressClass: "kong",
                annotations: {
                    "konghq.com/https-redirect-status-code": "301",
                    "konghq.com/protocols": "https",
                    "konghq.com/strip-path": "true",
                },
                hostname: pulumi.interpolate`${kongPortalSubdomain}.${kongBaseDomain}`,
                path: "/api",
                tls: "kong-controlplane-services-tls",
            },
            tls: {
                containerPort: 8447,
                enabled: true,
                parameters: [
                    "http2",
                ],
                servicePort: 8447,
            },
            type: "ClusterIP",
        },
        proxy: {
            enabled: false,
        },
        replicaCount: 1,
        secretVolumes: [
            "kong-controlplane-services-tls",
            "kong-cluster-cert",
        ],
        status: {
            enabled: true,
            http: {
                containerPort: 8100,
                enabled: true,
            },
            tls: {
                containerPort: 8543,
                enabled: true,
            },
        },
        migrations: {
            enabled: true,
            preUpgrade: true,
            postUpgrade: true,
        },
        extraLabels: {
            "konghq.com/component": "controlplane",
        },
        podAnnotations: {
            "kuma.io/gateway": "enabled",
        },
    },
},{
    dependsOn: [
        kongPostgres,
        kongServicesTls,
        kongClusterCert,
        secretKongSuperAdminCredentials,
    ],
    customTimeouts: {create: "2m", update: "2m", delete: "2m"},
    provider: kubeconfig,
});
////////////////////////////////////////////////////////////////////////////////////////////////////
// Kong Dataplane                                                                                 //
////////////////////////////////////////////////////////////////////////////////////////////////////
const kongDataPlane = new k8s.helm.v3.Release("dataplane", {
    name: "dataplane",
    chart: "kong",
    skipCrds: true,
    namespace: nsNameKong,
    repositoryOpts:{repo: "https://charts.konghq.com/"},
    values: {
        admin: {enabled: false},
        affinity: {
            podAffinity: {
                prefferedDuringSchedulingIgnoredDuringExecution: [
                    {
                        podAffinityTerm: {
                            labelSelector: {
                                matchExpressions: [
                                    {
                                        key: "app.kubernetes.io/instance",
                                        operator: "In",
                                        values: [
                                            "dataplane",
                                        ],
                                    },
                                ],
                            },
                            topologyKey: "kubernetes.io/hostname",
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
            license_secret: "kong-enterprise-license",
        },
        env: {
            cluster_cert: "/etc/secrets/kong-cluster-cert/tls.crt",
            cluster_cert_key: "/etc/secrets/kong-cluster-cert/tls.key",
            cluster_control_plane: "controlplane-kong-cluster:8005", // TODO: variablize controlplane-kong-clustertelemetry
            cluster_telemetry_endpoint: "controlplane-kong-clustertelemetry:8006", // TODO: variablize controlplane-kong-clustertelemetry
            ssl_cert_key: "/etc/secrets/kong-controlplane-services-tls/tls.key",
            ssl_cert: "/etc/secrets/kong-controlplane-services-tls/tls.crt",
            database: "off",
            log_level: kongLogLevel,
            lua_package_path: "/opt/?.lua;;",
            lua_ssl_trusted_certificate: "/etc/secrets/kong-cluster-cert/tls.crt,/etc/ssl/certs/ca-certificates.crt",
            nginx_worker_processes: "2",
            //plugins: pulumi.interpolate`"${kongPlugins}"`, // TODO: solve for plugin list syntax
            prefix: "/kong_prefix/",
            proxy_access_log: "/dev/stdout",
            proxy_error_log: "/dev/stdout",
            proxy_stream_error_log: "/dev/stdout",
            proxy_stream_access_log: "/dev/stdout",
            status_error_log: "/dev/stdout",
            role: "data_plane",
        },
        image: {
            repository: "docker.io/kong/kong-gateway",
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
            http: {
                containerPort: 8080,
                enabled: true,
                hostport: 80,
            },
            ingress: {enabled: false},
            labels: {
                "enable-metrics": true
            },
            tls: {
                containerPort: 8443,
                enabled: true,
                hostport: 443,
            },
            type: "ClusterIP",
        },
        replicaCount: 1,
        secretVolumes: [
            "kong-controlplane-services-tls",
            "kong-cluster-cert",
        ],
    },
},{
    provider: kubeconfig,
    parent: kongControlPlane,
    dependsOn: [
        kongPostgres,
        kongControlPlane,
        kongClusterCert,
        kongServicesTls,
    ],
    customTimeouts: {
        create: "2m",
        update: "2m",
        delete: "2m",
    },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
export const certManagerStatus = manager.status;