// https://github.com/pulumi/pulumi-kubernetes-cert-manager
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as certmanager from "@pulumi/kubernetes-cert-manager";
import { worker } from "cluster";

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
})

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
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Postgresql Helm Deploy
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
*/
const kongPostgres = new k8s.helm.v3.Chart("kong-postgres", {
    repo: "bitnami",
    chart: "postgresql",
    namespace: nsNameKong,
    fetchOpts: {repo: "https://charts.bitnami.com/bitnami"},
    values: {
        namespace: nsNameKong,
        nameOverride: "postgresql",
        postgresqlDatabase: "kong", // TODO: change hard coded pg user/database/password values to pulumi config variables
        postgresqlUsername: "kong",
        postgresqlPassword: "kong",
        postgresqlPostgresPassword: "kong",
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
        persistence: {enabled: true},
        replication: {enabled: false},
        securityContext: {enabled: true},
        volumePermissions: {enabled: true},
    },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Kong API Gateway
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Issue certificate for kong api
const kongServicesTls = new k8s.apiextensions.CustomResource("kongServicesTls", {
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
});

// Helm Kong Integrated Deploy
/*
const kongGateway = new k8s.helm.v3.Chart("konggateway", { // TODO: change hardcoded kongGateway value to pulumi config variable
    repo: "kong",
    chart: "kong",
    namespace: nsNameKong,
    fetchOpts: {repo: "https://charts.konghq.com/"},
    values: {
        namespace: nsNameKong,
        replicaCount: 1,
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
        deploymentAnnotations: {
            "sidecar.istio.io/inject": "false",
            "kuma.io/gateway": "enabled",
        },
        env: {
            log_level: "debug",
            plugins: "bundled",
            // START Database Configuration //
            database: "postgres",
            password: "kong_admin", // TODO: change hardcoded admin token to pulumi config variable
            pg_ssl: "off",
            pg_user: "kong", // TODO: change hard coded pg user/database/password values to pulumi config variables
            pg_database: "kong",
            pg_password: "kong",
            pg_host: "kong-postgres-postgresql.kong.svc.cluster.local", // TODO: convert from hard coded to dynamic value
            //pg_ssl_version: "tlsv1_2",
            // END Database Configuration //
            // START Admin API Configuration //
            admin_api_uri: "https://manager.kongpulumilabs.arpa/api", // change hard coded FQDN values to pulumi config
            admin_ssl_cert: "/etc/secrets/kong-services-tls/tls.crt",
            admin_ssl_cert_key: "/etc/secrets/kong-services-tls/tls.key",
            admin_access_log: "/dev/stdout",
            admin_error_log: "/dev/stdout",
            // END Admin API Configuration //
            // START Certificate configuration // -- // required if hybrid mode is enabled
            //cluster_cert: "/etc/secrets/kong-cluster-cert/tls.crt",
            //cluster_cert_key: "/etc/secrets/kong-cluster-cert/tls.key",
            //lua_ssl_trusted_certificate: "/etc/ssl/certs/ca-certificates.crt",
            // END Certificate configuration //
            trusted_ips: "0.0.0.0/0,::/0",
            status_listen: "0.0.0.0:8100",
            lua_package_path: "/opt/?.lua;;",
            nginx_worker_processes: "2",
            proxy_stream_access_log: "/dev/stdout",
            proxy_stream_error_log: "/dev/stdout",
            proxy_access_log: "/dev/stdout",
            proxy_error_log: "/dev/stdout",
            anonymous_reports: "off",
            prefix: "/kong_prefix/",
            smtp_mock: "off",
            vitals: "off",
            portal: "off",
        },
        secretVolumes: ["kong-services-tls"],
        //secretVolumes: ["kong-tls","kong-cluster-cert","kong-services-tls"], // required if hybrid mode is enabled
        enterprise: {
            enabled: false,
        },
        cluster: {
            enabled: false,
        },
        manager: {
            enabled: false,
        },
        portal: {
            enabled: false,
        },
        portalapi: {
            enabled: false,
        },
        clustertelemetry: {
            enabled: false,
        },
        migrations: {
            enabled: true,
            preUpgrade: true,
            postUpgrade: true,
        },
        status: {
            enabled: true,
            http: {
                enabled: true,
                containerPort: 8100,
            },
            https: {
                enabled: true,
                containerPort: 8543,
            },
        },
        podAnnotations: {
            "kuma.io/gateway": "enabled",
        },
        ingressController: {
            enabled: true,
            installCRDs: false,
            env: {
                publish_service: "kong/dataplane-kong-proxy",
                kong_admin_tls_skip_verify: "true",
                kong_admin_token: "kong_admin", // TODO: change hardcoded admin token to pulumi config variable
            },
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
                enabled: true,
            },
            https: {
                enabled: true,
                servicePort: 8444,
                containerPort: 8444,
                parameters: ["http2"],
            },
        },
        proxy: {
            enabled: true,
            type: "ClusterIP",
            http: {
                enabled: true,
                hostport: 80,
                containerPort: 8000,
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
        affinity: {
            podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                    {
                        podAffinityTerm: {
                            labelSelector: {
                                matchExpressions: [
                                    {
                                        key: "app.kubernetes.io/instance",
                                        operator: "In",
                                        values: ["konggateway"], // TODO: change hardcoded kongGateway value to pulumi config variable
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
    },
});
*/

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
export const certManagerStatus = manager.status;