// https://github.com/pulumi/pulumi-kubernetes-cert-manager
import * as k8s from "@pulumi/kubernetes";
import * as certmanager from "@pulumi/kubernetes-cert-manager";

// Create namespace.
const nsName = "cert-manager";
const ns = new k8s.core.v1.Namespace(nsName, {
    metadata: { name: nsName },
});

// Install cert-manager into cluster.
const manager = new certmanager.CertManager("cert-manager", {
    installCRDs: true,
    helmOptions: {
        namespace: nsName,
        values: {
            global: {
                operatorNamespace: nsName,
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
                namespace: nsName,
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
const rootIssuer = new k8s.apiextensions.CustomResource("issuerRoot", {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: {
        name: "certman-clusterissuer-selfsigned-issuer",
        namespace: nsName,
    },
    spec: {
        selfSigned: {},
    },
});

const rootSelfSignedCa = new k8s.apiextensions.CustomResource("selfSignCertificateAuthority", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "certman-clusterissuer-selfsigned-issuer-ca",
        namespace: nsName,
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

export const certManagerStatus = manager.status;