import { Construct } from "constructs";
import { App, Chart, ChartProps, Include, Yaml } from "cdk8s";
import {
  ConfigMap,
  Deployment,
  Namespace,
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
            nginx_config: {
              http: {
                client_body_temp_path: "temp/client_body_temp",
                proxy_temp_path: "temp/proxy_temp",
                fastcgi_temp_path: "temp/fastcgi_temp",
                uwsgi_temp_path: "temp/uwsgi_temp",
                scgi_temp_path: "temp/scgi_temp",
              },
            },
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
              // WARNING: Insecure for production. Restrict to trusted IPs.
              allow_admin: ["0.0.0.0/0"],
            },
          },
        }),
      },
    });

    // Define shared volumes
    const confVolume = Volume.fromEmptyDir(
      this,
      "data-plane-conf-volume",
      "apisix-conf",
    );
    const logsVolume = Volume.fromEmptyDir(
      this,
      "data-plane-logs-volume",
      "apisix-logs",
    );
    const tempVolume = Volume.fromEmptyDir(
      this,
      "data-plane-temp-volume",
      "apisix-temp",
    );
    const configMapVolume = Volume.fromConfigMap(
      this,
      "config-volume",
      configMap,
    );

    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },
      replicas: 1,
      podMetadata: { labels: labels },
      securityContext: {
        fsGroup: 1000,
      },
      volumes: [confVolume, logsVolume, tempVolume, configMapVolume],
    });

    const initContainer = deployment.addInitContainer({
      name: "copy-default-config",
      image: image,
      securityContext: {
        user: 1000,
      },
      command: ["sh", "-c", "cp -r /usr/local/apisix/conf/. /mnt/conf/"],
    });

    // Mount the volume to the init container.
    initContainer.mount("/mnt/conf", confVolume);

    deployment.addContainer({
      name: "apisix-control-plane",
      image: "apache/apisix:3.9.1-debian",
      securityContext: {
        user: 1000,
      },
      ports: [
        {
          number: 9180,
          name: "admin-api",
        },
      ],
      volumeMounts: [
        {
          volume: confVolume,
          path: "/usr/local/apisix/conf",
        },
        {
          volume: logsVolume,
          path: "/usr/local/apisix/logs",
        },
        {
          volume: tempVolume,
          path: "/usr/local/apisix/temp",
        },
        {
          volume: configMapVolume,
          path: "/usr/local/apisix/conf/config.yaml",
          subPath: "config.yaml",
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

    // 1. Define the Data Plane's configuration.
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

    // Define shared volumes
    const confVolume = Volume.fromEmptyDir(
      this,
      "data-plane-conf-volume",
      "apisix-conf",
    );
    const logsVolume = Volume.fromEmptyDir(
      this,
      "data-plane-logs-volume",
      "apisix-logs",
    );
    const configMapVolume = Volume.fromConfigMap(
      this,
      "config-volume",
      configMap,
    );

    // 3. Create the Kubernetes Deployment.
    const deployment = new Deployment(this, "deployment", {
      metadata: { namespace: APP_NAMESPACE },
      replicas: replicas,
      podMetadata: { labels: labels },
      securityContext: {
        fsGroup: 1000,
      },
      volumes: [confVolume, logsVolume, configMapVolume],
    });

    // 4. Add an init container using the idiomatic L2 method.
    const initContainer = deployment.addInitContainer({
      name: "copy-default-config",
      image: image,
      securityContext: {
        user: 1000,
      },
      command: ["sh", "-c", "cp -r /usr/local/apisix/conf/. /mnt/conf/"],
    });
    initContainer.mount("/mnt/conf", confVolume);

    // 5. Add the main application container.
    deployment.addContainer({
      name: "apisix-data-plane",
      image: image,
      ports: [{ number: 9080, name: "proxy-http" }],
      securityContext: {
        user: 1000,
      },
      volumeMounts: [
        {
          volume: confVolume,
          path: "/usr/local/apisix/conf",
        },
        {
          volume: logsVolume,
          path: "/usr/local/apisix/logs",
        },
        {
          volume: configMapVolume,
          path: "/usr/local/apisix/conf/config.yaml",
          subPath: "config.yaml",
        },
      ],
    });

    // 6. Expose the Data Plane proxy via a LoadBalancer Service.
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
