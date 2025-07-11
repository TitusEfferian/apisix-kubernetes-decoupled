import { Construct } from "constructs";

import { App, Chart, ChartProps, Include, Yaml } from "cdk8s";

import {
  ConfigMap,
  Deployment,
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

    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },

      replicas: 1,

      podMetadata: { labels: labels },

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

    const configDestVolume = Volume.fromEmptyDir(
      this,
      "config-dest-volume",
      "apisix-conf",
    );

    const initContainer = deployment.addInitContainer({
      name: "config-initializer",

      image: "busybox:1.36", // A minimal image for the copy task.

      command: ["sh", "-c", "cp -L /source-config/* /dest-config/"],
    });

    initContainer.mount("/source-config", configSourceVolume, {
      readOnly: true,
    });

    initContainer.mount("/dest-config", configDestVolume);

    const apisixContainer = deployment.addContainer({
      name: "apisix-control-plane",

      image: image,

      ports: [{ number: 9180, name: "admin-api" }],
    });

    apisixContainer.mount("/usr/local/apisix/conf", configDestVolume);

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

    // 1. Define the Data Plane's configuration.

    // This configuration disables the Admin API for security.

    const dataPlaneConfig = {
      apisix: {
        node_listen: 9080, // Listens for user-facing proxy traffic.

        enable_admin: false, // Critical: Disables the Admin API on the data plane.
      },

      deployment: {
        role: "data_plane", // Critical: Defines the instance role.

        role_data_plane: {
          config_provider: "etcd",
        },

        etcd: {
          host: [ETCD_HOST_FQDN], // Connects to the same etcd as the control plane.

          prefix: "/apisix",

          timeout: 30,
        },
      },
    };

    // 2. Create the Kubernetes ConfigMap.

    const configMap = new ConfigMap(this, "config", {
      metadata: {
        name: "apisix-data-plane-config",

        namespace: APP_NAMESPACE,
      },

      data: {
        "config.yaml": Yaml.stringify(dataPlaneConfig),
      },
    });

    // 3. Create the Kubernetes Deployment.

    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },

      replicas: replicas,

      podMetadata: { labels: labels },
    });

    const configVolume = Volume.fromConfigMap(this, "config-volume", configMap);

    deployment.addContainer({
      name: "apisix-data-plane",

      image: image,

      ports: [{ number: 9080, name: "proxy-http" }],

      volumeMounts: [
        {
          volume: configVolume,

          path: "/usr/local/apisix/conf/config.yaml",

          subPath: "config.yaml",
        },
      ],
    });

    // 4. Expose the Data Plane proxy via a LoadBalancer Service.

    // This makes the API gateway accessible from the internet.

    deployment.exposeViaService({
      name: "apisix-gateway",

      serviceType: ServiceType.LOAD_BALANCER,

      ports: [{ port: 80, targetPort: 9080, name: "http" }],
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
  }
}

const app = new App();

new MyChart(app, "etcd");

app.synth();
