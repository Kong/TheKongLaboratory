import * as k8s from "@pulumi/kubernetes";

//const kongnamespace = new k8s.core.v1.Namespace("ns", {metadata: {name: "kong",}});

// Deploy kong/kong hybrid controlplane helm chart
const kongcontrolplane = new k8s.helm.v3.Chart("controlplane", {
  repo: "kong",
  chart: "kong",
  version: "2.3.0",
  fetchOpts: {repo: "https://charts.konghq.com",},
  namespace: "kong", // TODO: variablize deploy namespace
  skipCRDRendering: false,
  values: {
    replicaCount: "1", // TODO: variablize controlplane replicaCount
    secretVolumes: ["kong-cluster-cert","kong-tls"],
    image: {
      repository: "kong/kong-gateway",
      tag: "2.5", // TODO: variablize image tag
    },
    deployment: {
      kong: {
        enabled: true,
        daemonset: false,
      },
    },
    env: {
      role: "control_plane",
      plugins: "bundled,openid-connect", // TODO: variablize kong plugin list
      log_level: "debug", // TODO: variablize log_level
      nginx_worker_processes: "2",
      status_listen: "0.0.0.0:8100",
      cluster_listen: "0.0.0.0:8005",
      cluster_telemetry_listen: "0.0.0.0:8006",
      cluster_data_plane_purge_delay: "60",
      lua_package_path: "/opt/?.lua;;",
      prefix: "/kong_prefix/",
      password: {
        valueFrom: {
          secretKeyRef: {
            name: "kong-enterprise-superuser-password",
            key: "password",
          },
        },
      },

      proxy_stream_error_log: "/dev/stdout",
      proxy_stream_access_log: "/dev/stdout",
      status_error_log: "/dev/stdout",
      proxy_access_log: "/dev/stdout",
      proxy_error_log: "/dev/stdout",

      database: "postgres",
      pg_user: {valueFrom: {secretKeyRef: {name:"kong-postgres-secrets", key:"user"}}},
      pg_host: {valueFrom: {secretKeyRef: {name:"kong-postgres-secrets", key:"pg_host"}}},
      pg_database: {valueFrom: {secretKeyRef: {name:"kong-postgres-secrets", key:"database"}}},
      pg_password: {valueFrom: {secretKeyRef: {name:"kong-postgres-secrets", key:"password"}}},
      pg_ssl_version: "tlsv1_2",
      pg_ssl: "on",

      cluster_cert: "/etc/secrets/kong-cluster-cert/tls.crt",
      cluster_cert_key: "/etc/secrets/kong-cluster-cert/tls.key",
      lua_ssl_trusted_certificate: "/etc/ssl/certs/ca-certificates.crt",

      vitals: "on",
      admin_gui_protocol: "https",
      admin_gui_host: "manager.kong.home.arpa",
      admin_gui_url: "https://manager.kong.home.arpa/",
      admin_api_uri: "https://manager.kong.home.arpa/api",
      admin_ssl_cert: "/etc/secrets/kong-tls/tls.crt",
      admin_ssl_cert_key: "/etc/secrets/kong-tls/tls.key",
      admin_gui_ssl_cert: "/etc/secrets/kong-tls/tls.crt",
      admin_gui_ssl_cert_key: "/etc/secrets/kong-tls/tls.key",
      admin_gui_access_log: "/dev/stdout",
      admin_gui_error_log: "/dev/stdout",
      admin_access_log: "/dev/stdout",
      admin_error_log: "/dev/stdout",

      //portal: "on",
      portal_cors_origins: "*",
      portal_auth: "basic-auth",
      portal_gui_protocol: "https",
      portal_gui_host: "portal.kong.home.arpa",
      portal_gui_url: "https://portal.kong.home.arpa/",
      portal_api_uri: "https://portal.kong.home.arpa/api",
      portal_gui_access_log: "/dev/stdout",
      portal_api_access_log: "/dev/stdout",
      portal_gui_error_log: "/dev/stdout",
      portal_api_error_log: "/dev/stdout",
      portal_session_conf: {
        valueFrom: {
          secretKeyRef: {
            name: "kong-session-config",
            key: "portal_session_conf",
          },
        },
      },
    },

    proxy: {
      enabled: false,
    },

    cluster: {
      enabled: true,
      tls: {
        enabled: true,
        servicePort: "8005",
        containerPort: "8005",
      },
    },

    clustertelemetry: {
      enabled: true,
      type: "ClusterIP",
      tls: {
        enabled: true,
        servicePort: "8006",
        containerPort: "8006",
      },
    },

    enterprise: {
      enabled: true,
      license_secret: "kong-enterprise-license",
      vitals: {
        enabled: true,
      },
      portal: {
        enabled: true,
      },
      rbac: {
        enabled: true,
        admin_gui_auth: "basic-auth",
        session_conf_secret: "kong-session-config",
        admin_gui_auth_conf_secret: "kong-session-config",
      },
      smtp: {
        enabled: false,
      },

      status: {
        enabled: true,
        http: {
          enabled: true,
          containerPort: "8100",
        },
        tls: {
          enabled: false,
          containerPort: "8543",
        },
      },
    },

    ingressController: {
      enabled: true,
      installCRDs: false,
      args: ["--v=5"],
      env: {
        publish_service: "kong/dataplane-kong-proxy",
        kong_admin_tls_skip_verify: true, // TODO: switch to enforce tls verification
        kong_admin_token: {
          valueFrom: {
            secretKeyRef: {
              name: "kong-enterprise-superuser-password",
              key: "password",
            },
          },
        },
      },
    },

    podAnnotations: {
      "kuma.io/gateway": "enabled",
    },

    admin: { // INFO: kong admin api
      enabled: true,
      type: "ClusterIP",
      annotations: {
        "konghq.com/protocol": "https",
      },
      ingress: {
        enabled: true,
        path: "/api",
        hostname: "manager.kong.home.arpa", // TODO: variablize manager fqdn
        tls: "kong-tls",
        annotations: {
          "konghq.com/protocols": "https",
          "konghq.com/strip-path": "true",
          "konghq.com/https-redirect-status-code": "301",
          "kubernetes.io/ingress.class": "kong",
        },
      },
      http: {
        enabled: false,
      },
      tls: {
        enabled: true,
        servicePort: "8444",
        containerPort: "8444",
        parameters: ["http2"],
      },
    },

    portalapi: { // INFO: kong developer portal api
      enabled: true,
      type: "ClusterIP",
      annotations: {
        "konghq.com/protocol": "https",
      },
      ingress: {
        enabled: true,
        path: "/api",
        hostname: "portal.kong.home.arpa", // TODO: variablize portal fqdn
        tls: "kong-tls",
        annotations: {
          "konghq.com/protocols": "https",
          "konghq.com/strip-path": "true",
          "konghq.com/https-redirect-status-code": "301",
          "kubernetes.io/ingress.class": "kong",
        },
      },
      http: {
        enabled: false,
      },
      tls: {
        enabled: true,
        servicePort: "8447",
        containerPort: "8447",
        parameters: ["http2"],
      },
    },

    manager: { // INFO: kong admin manager webui portal
      enabled: true,
      type: "ClusterIP",
      annotations: {
        "konghq.com/protocol": "https",
      },
      ingress: {
        enabled: true,
        path: "/",
        hostname: "manager.kong.home.arpa", // TODO: variablize manager fqdn
        tls: "kong-tls",
        annotations: {
          "konghq.com/protocols": "https",
          "konghq.com/strip-path": "true",
          "konghq.com/https-redirect-status-code": "301",
          "kubernetes.io/ingress.class": "kong",
        },
      },
      http: {
        enabled: false,
      },
      tls: {
        enabled: true,
        servicePort: "8445",
        containerPort: "8445",
        parameters: ["http2"],
      },
    },

    portal: { // INFO: kong admin manager webui portal
      enabled: true,
      type: "ClusterIP",
      annotations: {
        "konghq.com/protocol": "https",
      },
      ingress: {
        enabled: true,
        path: "/",
        hostname: "portal.kong.home.arpa", // TODO: variablize manager fqdn
        tls: "kong-tls",
        annotations: {
          "konghq.com/protocols": "https",
          "konghq.com/strip-path": "true",
          "konghq.com/https-redirect-status-code": "301",
          "kubernetes.io/ingress.class": "kong",
        },
      },
      http: {
        enabled: false,
      },
      tls: {
        enabled: true,
        servicePort: "8446",
        containerPort: "8446",
        parameters: ["http2"],
      },
    },
  },
});

const kongdataplane = new k8s.helm.v3.Chart("dataplane", {
  repo: "kong",
  chart: "kong",
  version: "2.3.0",
  fetchOpts: {repo: "https://charts.konghq.com",},
  namespace: "kong", // TODO: variablize deploy namespace
  skipCRDRendering: true,
  values: {
    "replicaCount": 1,
    "image": {
      repository: "kong/kong-gateway",
      tag: "2.5", // TODO: variablize image tag
    },
    deployment: {
      kong: {
        enabled: true,
        daemonset: false,
      }
    },
    env: {
      role: "data_plane",
      plugins: "bundled,openid-connect", // TODO: variablize kong plugin list
      database: "off",
      log_level: "debug", // TODO: variablize log_level
      prefix: "/kong_prefix/",
      nginx_worker_processes: "2",
      lua_package_path: "/opt/?.lua;;",
      cluster_cert: "/etc/secrets/kong-cluster-cert/tls.crt",
      cluster_cert_key: "/etc/secrets/kong-cluster-cert/tls.key",
      lua_ssl_trusted_certificate: "/etc/ssl/certs/ca-certificates.crt",
      cluster_control_plane: "controlplane-kong-cluster.kong.svc.cluster.local:8005",
      cluster_telemetry_endpoint: "controlplane-kong-clustertelemetry.kong.svc.cluster.local:8006",
      proxy_stream_access_log: "/dev/stdout",
      proxy_stream_error_log: "/dev/stdout",
      status_error_log: "/dev/stdout",
      proxy_access_log: "/dev/stdout",
      proxy_error_log: "/dev/stdout",
    },
    enterprise: {
      enabled: true,
      license_secret: "kong-enterprise-license",
    },
    secretVolumes: [
      "kong-cluster-cert",
      "kong-tls"
    ],
    proxy: {
      enabled: true,
      type: "LoadBalancer",
      http: {
        enabled: true,
        hostPort: 80,
        containerPort: 8080,
      },
      tls: {
        enabled: true,
        hostPort: 443,
        containerPort: 8443,
      },
      ingress: {
        enabled: false,
      },
      labels: {
        "enable-metrics": true,
      },
      annotations: {
        "prometheus.io/port": "9542",
        "prometheus.io/scrape": "true",
      },
    },
    admin: {
      enabled: false,
    },
    portal: {
      enabled: false,
    },
    cluster: {
      enabled: false,
    },
    manager: {
      enabled: false,
    },
    portalapi: {
      enabled: false,
    },
    migrations: {
      preUpgrade: false,
      postUpgrade: false,
    },
    ingressController: {
      enabled: false,
      installCRDs: false,
    },
  },
},{
  parent: kongcontrolplane,
});

// Get the status field from the kongcontrolplane service, and then grab a reference to the ingress field.
//const frontend = kongcontrolplane.getResourceProperty("v1/Service", "controlplane-kongcontrolplane", "status");
//const ingress = frontend.loadBalancer.ingress[0];

// Export the public IP for Kong.
// Depending on the k8s cluster, this value may be an IP address or a hostname.
//export const frontendIp = ingress.apply(x => x.ip ?? x.hostname);
