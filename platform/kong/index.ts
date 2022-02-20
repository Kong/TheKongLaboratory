// https://github.com/pulumi/pulumi-kubernetes-cert-manager
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as certmanager from "@pulumi/kubernetes-cert-manager";
import { env } from "process";

// Export the cluster's kubeconfig.
const kubeconfig = new k8s.Provider("kubeconfig", {
    context: "kind-kongpulumilabs01",
    kubeconfig: env.KUBECONFIG,
    suppressHelmHookWarnings: true,
    enableDryRun: true,
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Create namespaces.
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const nsNameKong = "kong";
const nsNameCertManager = "cert-manager";

const nsCertManager = new k8s.core.v1.Namespace(nsNameCertManager, {
    metadata: { name: nsNameCertManager },
});

const nsKong = new k8s.core.v1.Namespace(nsNameKong, {
    metadata: { name: nsNameKong },
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Deploy Certificate Manager
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Install cert-manager into cluster.
const manager = new certmanager.CertManager("cert-manager", {
    installCRDs: true,
    helmOptions: {
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
}, { dependsOn: nsCertManager });

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
}, { dependsOn: manager });

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
}, { dependsOn: rootIssuer });

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
}, { dependsOn: rootSelfSignedCa });

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Postgresql Helm Deploy
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
*/
const kongPostgres = new k8s.helm.v3.Release("postgres", {
    chart: "postgresql",
    namespace: nsNameKong,
    repositoryOpts: { repo: "https://charts.bitnami.com/bitnami" },
    values: {
        namespace: nsNameKong,
        fullnameOverride: "postgres",
        global: {
            storageClass: "",
            postgresql: {
                auth: {
                    username: "kong",
                    password: "kong",
                    database: "kong",
                    postgresPassword: "",
                },
            },
        },
        image: {
            pullPolicy: "IfNotPresent",
            tag: "14.1.0-debian-10-r80",
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
}, { dependsOn: nsKong });

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Kong API Gateway // ControlPlane
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Issue certificate for kong api
const kongServicesTls = new k8s.apiextensions.CustomResource("kong-services-tls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "kong-services-tls",
        namespace: nsNameKong,
    },
    spec: {
        secretName: "kong-services-tls",
        commonName: "kongpulumilabs.arpa", // TODO: Replace static FQDN with pulumi config variable
        dnsNames: [
            "*.kongpulumilabs.arpa",
            "apps.kongpulumilabs.arpa",
            "proxy.kongpulumilabs.arpa",
            "manager.kongpulumilabs.arpa",
        ],
        isCa: false,
        duration: "8760h",
        renewBefore: "360h",
        issuerRef: {
            name: "certman-selfsigned-issuer",
            kind: "ClusterIssuer",
        },
    },
}, { dependsOn: certmanSelfsignedIssuer });

// Issue certificate for kong cluster mtls
const kongClusterMtls = new k8s.apiextensions.CustomResource("kong-cluster-mtls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "kong-cluster-mtls",
        namespace: nsNameKong,
    },
    spec: {
        secretName: "kong-cluster-mtls",
        commonName: "kongpulumilabs.arpa", // TODO: Replace static FQDN with pulumi config variable
        dnsNames: [
            "*.kongpulumilabs.arpa",
            "apps.kongpulumilabs.arpa",
            "proxy.kongpulumilabs.arpa",
            "manager.kongpulumilabs.arpa",
        ],
        isCa: false,
        duration: "8760h",
        renewBefore: "360h",
        issuerRef: {
            name: "certman-selfsigned-issuer",
            kind: "ClusterIssuer",
        },
    },
}, { dependsOn: certmanSelfsignedIssuer });

// Helm Kong Integrated Deploy
const kongControlPlane = new k8s.helm.v3.Release("controlplane", {
    chart: "kong",
    namespace: nsNameKong,
    repositoryOpts: { repo: "https://charts.konghq.com/" },
    values: {
        namespace: nsNameKong,
        replicaCount: 1,
        extraLabels: {
            "konghq.com/component": "controlplane",
        },
        image: {
            repository: "docker.io/kong/kong-gateway",
            tag: "2.7",
        },
        deployment: {
            kong: {
                enabled: true,
                daemonset: false,
            },
        },
        env: {
            role: "control_plane",
            plugins: "bundled",
            log_level: "debug",
            password: "kong_admin", // TODO: change hardcoded admin token to pulumi config variable
            cluster_listen: "0.0.0.0:8005",
            proxy_stream_access_log: "/dev/stdout",
            proxy_stream_error_log: "/dev/stdout",
            lua_package_path: "/opt/?.lua;;",
            proxy_access_log: "/dev/stdout",
            proxy_error_log: "/dev/stdout",
            nginx_worker_processes: "2",
            prefix: "/kong_prefix/",
            smtp_mock: "off",
            vitals: "off",
            portal: "off",

            // START Database Configuration //
            database: "postgres",
            pg_user: "kong", // TODO: change hard coded pg user/database/password values to pulumi config variables
            pg_host: "postgres.kong.svc.cluster.local",
            pg_port: "5432",
            pg_database: "kong",
            pg_password: "kong",
            pg_ssl: "off", // WARN: database SSL disabled on DB, do not use this mode in production
            pg_ssl_verify: "off", // WARN: database ssl verification disabled, not recommended for production
            // END Database Configuration //

            // START Admin API Configuration //
            admin_api_uri: "https://manager.kongpulumilabs.arpa/api", // change hard coded FQDN values to pulumi config
            admin_ssl_cert: "/etc/secrets/kong-services-tls/tls.crt",
            admin_ssl_cert_key: "/etc/secrets/kong-services-tls/tls.key",
            admin_access_log: "/dev/stdout",
            admin_error_log: "/dev/stdout",
            // END Admin API Configuration //

            //// START Proxy Configuration //
            ssl_cert: "/etc/secrets/kong-services-tls/tls.crt",
            ssl_cert_key: "/etc/secrets/kong-services-tls/tls.key",
            //// END Proxy Configuration //

            //// START Cluster MTLS Configuration //
            cluster_cert: "/etc/secrets/kong-cluster-mtls/tls.crt",
            cluster_cert_key: "/etc/secrets/kong-cluster-mtls/tls.key",
            //// END Cluster MTLS Configuration //
        },
        secretVolumes: [
            "kong-services-tls",
            "kong-cluster-mtls",
        ],
        cluster: {
            enabled: true,
            type: "ClusterIP",
            labels: {
                "konghq.com/service": "cluster",
            },
            tls: {
                enabled: true,
            },
        },
        ingressController: {
            enabled: true,
            installCRDs: false,
            env: {
                publish_service: "kong/kong-ingress-controller",
                kong_admin_token: "kong_admin", // TODO: change hardcoded admin token to pulumi config variable
                kong_admin_tls_skip_verify: "true",
            },
        },
        migrations: {
            enabled: true,
            preUpgrade: true,
            postUpgrade: true,
        },
        admin: {
            enabled: true,
            type: "ClusterIP",
            annotations: {
                "konghq.com/protocol": "https",
            },
            ingress: {
                enabled: true,
                path: "/api",
                hostname: "manager.kongpulumilabs.arpa", // TODO: change hardcoded FQDN to pulumi config variable
                tls: "kong-services-tls",
                ingresClass: "kong",
                annotations: {
                    "konghq.com/protocols": "https",
                    "konghq.com/strip-path": "true",
                    "konghq.com/https-redirect-status-code": "301",
                },
            },
            http: {
                enabled: false,
            },
            tls: {
                enabled: true,
                parameters: ["http2"],
            },
        },
        proxy: {
            enabled: false,
        },
    },
}, {
    dependsOn: [
        kongPostgres,
        kongServicesTls,
        kongClusterMtls,
    ],
    customTimeouts: {
        create: "3m",
        update: "2m",
        delete: "2m",
    },
});

// Export Cluster Service Names
//const srvClusterName = k8s.core.v1.Service.get("cluster", pulumi.interpolate`${nsNameKong}/${kongControlPlane.status.name}-kong-cluster`);


////////////////////////////////////////////////////////////////////////////////////////////////////
// Kong Dataplane                                                                                 //
////////////////////////////////////////////////////////////////////////////////////////////////////
const kongDataPlane = new k8s.helm.v3.Release("dataplane", {
    chart: "kong",
    namespace: nsNameKong,
    skipCrds: true,
    repositoryOpts:{
        repo: "https://charts.konghq.com/",
    },
    values: {
        namespace: nsNameKong,
        replicaCount: 1,
        image: {
            repository: "docker.io/kong/kong-gateway",
            tag: "2.7",
        },
        env: {
            database: "off",
            role: "data_plane",
            prefix: "/kong_prefix/",
            cluster_control_plane: pulumi.interpolate`${kongControlPlane}.kong.srv.cluster.local:8005`,
            ssl_cert: "/etc/secrets/kong-services-tls/tls.crt",
            ssl_cert_key: "/etc/secrets/kong-services-tls/tls.key",
            cluster_cert: "/etc/secrets/kong-cluster-mtls/tls.crt",
            cluster_cert_key: "/etc/secrets/kong-cluster-mtls/tls.key",
        },
        secretVolumes: [
            "kong-services-tls",
            "kong-cluster-mtls",
        ],
        proxy: {
            enabled: true,
            type: "ClusterIP",
            http: {
                enabled: true,
                hostport: 80,
                containerPort: 8080,
            },
            tls: {
                enabled: true,
                hostport: 443,
                containerPort: 8443,
            },
            ingress: {
                enabled: false,
            },
        },
        admin: {enabled: false},
        portal: {enabled: false},
        cluster: {enabled: false},
        manager: {enabled: false},
        portalapi: {enabled: false},
        ingressController: {enabled: false, installCRDs: false},
  },
},{
    provider: kubeconfig,
    parent: kongControlPlane,
    dependsOn: [
        kongPostgres,
        kongControlPlane,
        kongClusterMtls,
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