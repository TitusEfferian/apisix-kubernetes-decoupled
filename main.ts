import { Construct } from "constructs";

import { App, Chart, ChartProps, Include, Yaml } from "cdk8s";

import {
  ConfigMap,
  ContainerSecurityContext,
  Deployment,
  EnvValue,
  Namespace,
  PodSecurityContext,
  ServiceType,
  Volume,
} from "cdk8s-plus-28";

const APP_NAMESPACE = "default";

const ETCD_HOST_FQDN = `http://etcd.${APP_NAMESPACE}.svc.cluster.local:2379`;

class ApisixControlPlane extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const labels = { app: "apisix-control-plane" };
    const image = "apache/apisix:3.9.1-debian";

    const configMap = new ConfigMap(this, "config", {
      metadata: {
        namespace: APP_NAMESPACE,
        name: "apisix-control-plane-config",
      },
      data: {
        "config.yaml": Yaml.stringify({
          apisix: {
            node_listen: 9080,
          },
          deployment: {
            role: "control_plane",
            role_control_plane: {
              config_provider: "etcd",
            },
            etcd: {
              host: [ETCD_HOST_FQDN],
              prefix: "/apisix",
              timeout: 30,
            },
            admin: {
              admin_listen: {
                port: 9180,
              },
              admin_key: [
                {
                  name: "admin",
                  key: "edd1c9f034335f136f87ad84b625c8f1",
                  role: "admin",
                },
              ],
              allow_admin: ["0.0.0.0/0"],
            },
          },
        }),
      },
    });

    const configSourceVolume = Volume.fromConfigMap(
      this,
      "config-source-volume",
      configMap,
    );

    const apisixWritableVolume = Volume.fromEmptyDir(
      this,
      "apisix-writable-dir-volume",
      "apisix-writable-dir",
    );

    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },
      replicas: 1,
      podMetadata: { labels: labels },
      securityContext: new PodSecurityContext({
        user: 1000,
        fsGroup: 1000,
        group: 1000,
      }),
      containers: [
        {
          name: "apisix-control-plane",
          image: image,
          ports: [{ number: 9180, name: "admin-api" }],
          volumeMounts: [
            {
              volume: apisixWritableVolume,
              path: "/usr/local/apisix",
            },
          ],
        },
      ],
      initContainers: [
        {
          name: "config-initializer",
          image: image,
          securityContext: {
            user: 0,
            ensureNonRoot: false,
          },
          command: [
            "sh",
            "-c",
            "cp -r /usr/local/apisix/* /writable-apisix/ && cp /source-config/config.yaml /writable-apisix/conf/config.yaml && chown -R 1000:1000 /writable-apisix",
          ],
          volumeMounts: [
            {
              volume: configSourceVolume,
              path: "/source-config",
              readOnly: true,
            },
            {
              volume: apisixWritableVolume,
              path: "/writable-apisix",
            },
          ],
        },
      ],
    });

    deployment.exposeViaService({
      name: "apisix-admin",
      serviceType: ServiceType.CLUSTER_IP,
      ports: [
        {
          port: 9180,
          targetPort: 9180,
          name: "admin-api",
        },
      ],
    });
  }
}

export class ApisixDataPlane extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const image = "apache/apisix:3.9.1-debian";
    const replicas = 2;
    const labels = { app: "apisix-data-plane" };

    const dataPlaneConfig = {
      apisix: {
        node_listen: 9080,
        enable_admin: false,
      },
      deployment: {
        role: "data_plane",
        role_data_plane: {
          config_provider: "etcd",
        },
        etcd: {
          host: [ETCD_HOST_FQDN],
          prefix: "/apisix",
          timeout: 30,
        },
      },
    };

    const configMap = new ConfigMap(this, "config", {
      metadata: {
        name: "apisix-data-plane-config",
        namespace: APP_NAMESPACE,
      },
      data: {
        "config.yaml": Yaml.stringify(dataPlaneConfig),
      },
    });

    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },
      replicas: replicas,
      podMetadata: { labels: labels },
      // This security context applies to the main container.
      securityContext: new PodSecurityContext({
        user: 1000,
        fsGroup: 1000,
        group: 1000,
      }),
    });

    const configSourceVolume = Volume.fromConfigMap(
      this,
      "config-source-volume",
      configMap,
    );

    const apisixWritableVolume = Volume.fromEmptyDir(
      this,
      "apisix-writable-dir-volume",
      "apisix-writable-dir",
    );

    const tmpVolume = Volume.fromEmptyDir(this, "tmp-volume", "tmp");

    const initContainer = deployment.addInitContainer({
      name: "config-initializer",
      image: image,
      securityContext: {
        user: 0,
        ensureNonRoot: false,
      },
      command: [
        "sh",
        "-c",
        "cp -r /usr/local/apisix/* /writable-apisix/ && cp /source-config/config.yaml /writable-apisix/conf/config.yaml && chown -R 1000:1000 /writable-apisix",
      ],
    });

    initContainer.mount("/source-config", configSourceVolume, {
      readOnly: true,
    });
    initContainer.mount("/writable-apisix", apisixWritableVolume);

    const apisixContainer = deployment.addContainer({
      name: "apisix-data-plane",
      image: image,
      ports: [{ number: 9080, name: "proxy-http" }],
    });

    apisixContainer.mount("/usr/local/apisix", apisixWritableVolume);
    apisixContainer.mount("/tmp", tmpVolume);

    deployment.exposeViaService({
      name: "apisix-gateway",
      serviceType: ServiceType.LOAD_BALANCER,
      ports: [{ port: 80, targetPort: 9080, name: "http" }],
    });
  }
}

export class ApisixDashboard extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const labels = { app: "apisix-dashboard" };
    // MODIFICATION: Switched to the Bitnami image. Using a specific, immutable tag is recommended for production.
    const image = "bitnami/apisix-dashboard:latest";
    const adminApiKey = "edd1c9f034335f136f87ad84b625c8f1";

    // MODIFICATION: The Bitnami image uses different configuration.
    // - The frontend config (config.json) is now handled by environment variables.
    // - The backend config (conf.yaml) is simplified. The listening port is changed to 8080.
    // - Log paths are removed to allow the container to log to stdout, which is standard practice.
    const configMap = new ConfigMap(this, "config", {
      metadata: {
        namespace: APP_NAMESPACE,
        name: "apisix-dashboard-config",
      },
      data: {
        "conf.yaml": Yaml.stringify({
          conf: {
            listen: {
              host: "0.0.0.0",
              port: 8080, // Bitnami image listens on port 8080 by default.
            },
            etcd: {
              endpoints: [ETCD_HOST_FQDN],
            },
            authentication: {
              secret: "secret", // IMPORTANT: Change this in a real environment
              expire_time: 3600,
              users: [
                {
                  username: "admin",
                  password: "admin",
                },
                {
                  username: "user",
                  password: "user",
                },
              ],
            },
          },
        }),
      },
    });

    const configVolume = Volume.fromConfigMap(this, "config-volume", configMap);
    const logsVolume = Volume.fromEmptyDir(
      this,
      "logs-volume",
      "apisix-dashboard-logs",
    );

    const deployment = new Deployment(this, "deployment", {
      metadata: {
        namespace: APP_NAMESPACE,
        name: "apisix-dashboard",
      },
      podMetadata: { labels },
      replicas: 1,
      // MODIFICATION: Added PodSecurityContext. The fsGroup ensures that volumes are writable by the non-root user.
      securityContext: new PodSecurityContext({
        fsGroup: 1001,
      }),
      containers: [
        {
          name: "apisix-dashboard",
          image: image,
          // MODIFICATION: Set security context to run as the non-root 'bitnami' user (1001).
          securityContext: new ContainerSecurityContext({
            user: 1001,
            group: 1001,
            ensureNonRoot: true,
          }),
          // MODIFICATION: The container port is now 8080.
          ports: [{ number: 8080, name: "http" }],
          // MODIFICATION: Configure API endpoint via environment variables, the Bitnami-native way.
          envVariables: {
            // This sets the backend API endpoint for the frontend UI.
            APISIX_DASHBOARD_API_URL_1: EnvValue.fromValue(
              `http://apisix-admin.${APP_NAMESPACE}.svc.cluster.local:9180`,
            ),
            // This sets the API key for the backend.
            APISIX_DASHBOARD_API_KEY_1: EnvValue.fromValue(adminApiKey),
          },
          // MODIFICATION: Volume mounts are updated for the Bitnami image's file structure.
          // The config.json mount is no longer needed.
          volumeMounts: [
            {
              volume: configVolume,
              path: "/opt/bitnami/apisix-dashboard/conf/conf.yaml",
              subPath: "conf.yaml",
            },
            {
              volume: logsVolume,
              path: "/opt/bitnami/apisix-dashboard/logs",
            },
          ],
        },
      ],
    });

    deployment.exposeViaService({
      name: "apisix-dashboard",
      serviceType: ServiceType.CLUSTER_IP,
      // MODIFICATION: The service now targets the container's port 8080.
      ports: [{ port: 80, targetPort: 8080 }],
    });
  }
}

export class MyChart extends Chart {
  constructor(scope: Construct, id: string, props: ChartProps = {}) {
    super(scope, id, props);

    new Namespace(this, "namespace", {
      metadata: {
        name: APP_NAMESPACE,
      },
    });

    new Include(this, "etcd", {
      url: "etcd.yaml",
    });

    new ApisixControlPlane(this, "apisix-control-plane");

    new ApisixDataPlane(this, "apisix-data-plane");

    new ApisixDashboard(this, "apisix-dashboard");
  }
}

const app = new App();

new MyChart(app, "etcd");

app.synth();
