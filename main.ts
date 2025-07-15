import { Construct } from "constructs";

import { App, Chart, ChartProps } from "cdk8s";

import {
  ConfigMap,
  ContainerSecurityContext,
  Deployment,
  EmptyDirMedium,
  Namespace,
  PodSecurityContext,
  Service,
  ServiceType,
  Volume,
} from "cdk8s-plus-28";
import * as fs from "fs";
import * as path from "path";

const APP_NAMESPACE = "default";

class Standalone extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const labels = { app: "apisix-standalone" };
    const image = "apache/apisix:3.9.1-debian";

    // --- ConfigMap for APISIX Engine Configuration (`config.yaml`) ---
    const apisixEngineConfigMap = new ConfigMap(this, "apisix-engine-config", {
      metadata: {
        name: "apisix-engine-config",
        namespace: APP_NAMESPACE,
      },
      data: {
        "config.yaml": fs.readFileSync(
          path.join(__dirname, "config.yaml"),
          "utf-8",
        ),
      },
    });

    // --- ConfigMap for APISIX Routes (`apisix.yaml`) ---
    const apisixRoutesConfigMap = new ConfigMap(this, "apisix-routes-config", {
      metadata: {
        name: "apisix-routes-config",
        namespace: APP_NAMESPACE,
      },
      data: {
        "apisix.yaml": fs.readFileSync(
          path.join(__dirname, "apisix.yaml"),
          "utf-8",
        ),
      },
    });

    // --- Volumes ---
    const configVolume = Volume.fromConfigMap(
      this,
      "config-volume",
      apisixEngineConfigMap,
    );
    const routesVolume = Volume.fromConfigMap(
      this,
      "routes-volume",
      apisixRoutesConfigMap,
    );
    // A writable emptyDir volume for the configuration directory.
    const confVolume = Volume.fromEmptyDir(this, "conf-volume", "apisix-conf", {
      medium: EmptyDirMedium.MEMORY,
    });
    // A writable emptyDir volume for the /tmp directory.
    const tmpVolume = Volume.fromEmptyDir(this, "tmp-volume", "apisix-tmp", {
      medium: EmptyDirMedium.MEMORY,
    });
    // A writable emptyDir volume for client body temp files.
    const clientBodyTempVolume = Volume.fromEmptyDir(
      this,
      "client-body-temp-volume",
      "apisix-client-body-temp",
      { medium: EmptyDirMedium.MEMORY },
    );
    // A writable emptyDir volume for proxy temp files.
    const proxyTempVolume = Volume.fromEmptyDir(
      this,
      "proxy-temp-volume",
      "apisix-proxy-temp",
      { medium: EmptyDirMedium.MEMORY },
    );

    const fastCgiTemp = Volume.fromEmptyDir(
      this,
      "fast-cgi-temp",
      "fast-cgi-temp",
      { medium: EmptyDirMedium.MEMORY },
    );

    const uswgiTemp = Volume.fromEmptyDir(this, "uswgi-temp", "uswgi-temp", {
      medium: EmptyDirMedium.MEMORY,
    });

    const scgiTemp = Volume.fromEmptyDir(this, "scgi-temp", "scgi-temp", {
      medium: EmptyDirMedium.MEMORY,
    });

    const logsVolume = Volume.fromEmptyDir(this, "logs-volume", "apisix-logs", {
      medium: EmptyDirMedium.MEMORY,
    });

    // --- APISIX Deployment ---
    const deployment = new Deployment(this, "deployment", {
      metadata: {
        namespace: APP_NAMESPACE,
        labels: labels,
      },
      replicas: 1,
      securityContext: new PodSecurityContext({
        fsGroup: 1000,
        user: 1000,
      }),
      initContainers: [
        {
          name: "init-config",
          image: image,
          command: ["sh", "-c"],
          args: [
            "cp -r /usr/local/apisix/conf/* /mnt/apisix-conf/ && " +
              "cp /mnt/config-files/config.yaml /mnt/apisix-conf/config.yaml && " +
              "cp /mnt/route-files/apisix.yaml /mnt/apisix-conf/apisix.yaml",
          ],
          volumeMounts: [
            {
              volume: confVolume,
              path: "/mnt/apisix-conf",
            },
            {
              volume: configVolume,
              path: "/mnt/config-files",
            },
            {
              volume: routesVolume,
              path: "/mnt/route-files",
            },
          ],
        },
      ],
      containers: [
        {
          name: "apisix",
          image: image,
          ports: [{ number: 9080 }],
          securityContext: new ContainerSecurityContext({
            allowPrivilegeEscalation: false,
          }),
          // Mount all necessary writable directories.
          volumeMounts: [
            {
              volume: confVolume,
              path: "/usr/local/apisix/conf",
            },
            {
              volume: tmpVolume,
              path: "/tmp",
            },
            {
              volume: clientBodyTempVolume,
              path: "/usr/local/apisix/client_body_temp",
            },
            {
              volume: proxyTempVolume,
              path: "/usr/local/apisix/proxy_temp",
            },
            {
              volume: fastCgiTemp,
              path: "/usr/local/apisix/fastcgi_temp",
            },
            {
              volume: uswgiTemp,
              path: "/usr/local/apisix/uwsgi_temp",
            },
            {
              volume: scgiTemp,
              path: "/usr/local/apisix/scgi_temp",
            },
            {
              volume: logsVolume,
              path: "/usr/local/apisix/logs",
            },
          ],
        },
      ],
      // Add all volumes to the pod's list of volumes.
      volumes: [
        configVolume,
        routesVolume,
        confVolume,
        tmpVolume,
        clientBodyTempVolume,
        proxyTempVolume,
        fastCgiTemp,
        uswgiTemp,
        scgiTemp,
        logsVolume,
      ],
    });

    // --- Service to Expose APISIX Gateway ---
    new Service(this, "gateway-service", {
      metadata: {
        namespace: APP_NAMESPACE,
      },
      selector: deployment,
      type: ServiceType.LOAD_BALANCER,
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

    new Standalone(this, "standalone");
  }
}

const app = new App();

new MyChart(app, "etcd");

app.synth();
