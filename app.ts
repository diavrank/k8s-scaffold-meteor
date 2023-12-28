// Copyright 2016-2019, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Arguments for the demo app.
export interface DemoAppArgs {
    provider: k8s.Provider; // Provider resource for the target Kubernetes cluster.
    imageTag: string; // Tag for the kuard image to deploy.
    staticAppIP?: pulumi.Input<string>; // Optional static IP to use for the service. (Required for AKS).
}

const environmentVariableNames = [
    'MAIL_URL',
    'ROOT_URL',
    'MONGO_URL',
    'STORAGE_PATH',
    'TZ',
    'PORT',
    'REFRESH_STATIC_PROFILES',
    'REFRESH_PERMISSIONS',
    'EMAIL_SERVICES',
];

const environmentVariables = environmentVariableNames
    .map(envName => ({name: envName, value: process.env[envName]}));

const APP_PORT = parseInt(process.env.PORT!) || 3000;
const DATABASE_IP_ADDRESS = process.env.DATABASE_IP_ADDRESS;
console.log('DATABASE_IP_ADDRESS: ', DATABASE_IP_ADDRESS);

export class DemoApp extends pulumi.ComponentResource {
    public appUrl: pulumi.Output<string>;

    constructor(name: string,
                args: DemoAppArgs,
                opts: pulumi.ComponentResourceOptions = {}) {
        super("examples:kubernetes-ts-multicloud:demo-app", name, args, opts);

        // Create the kuard Deployment.
        const appLabels = {app: "scaffold"};
        const deployment = new k8s.apps.v1.Deployment(`${name}-scaffold-app`, {
            spec: {
                selector: {matchLabels: appLabels},
                replicas: 2,
                template: {
                    metadata: {labels: appLabels},
                    spec: {
                        containers: [
                            {
                                name: "scaffold",
                                image: `docker.io/diavrank/scaffold-meteor-vue:${args.imageTag}`,
                                ports: [{containerPort: APP_PORT, name: "http"}],
                                env: environmentVariables,
                                livenessProbe: {
                                    httpGet: {path: "/api", port: "http"},
                                    initialDelaySeconds: 5,
                                    timeoutSeconds: 1,
                                    periodSeconds: 10,
                                    failureThreshold: 3,
                                },
                                readinessProbe: {
                                    httpGet: {path: "/api/v1", port: "http"},
                                    initialDelaySeconds: 5,
                                    timeoutSeconds: 1,
                                    periodSeconds: 10,
                                    failureThreshold: 3,
                                },
                            },
                        ],
                        // Adding hostAliases to the spec
                        hostAliases: [{
                            ip: DATABASE_IP_ADDRESS,
                            hostnames: [
                                "mongo-primary",
                                "mongo-secondary",
                                "mongo-arbiter",
                            ],
                        }],
                    },
                },
            },
        }, {provider: args.provider, parent: this});

        // Create a LoadBalancer Service to expose the scaffold Deployment.
        const service = new k8s.core.v1.Service(`${name}-scaffold-app`, {
            spec: {
                loadBalancerIP: args.staticAppIP, // Required for AKS - automatic LoadBalancer still in preview.
                selector: appLabels,
                ports: [{port: 80, targetPort: APP_PORT}],
                type: "LoadBalancer",
            },
        }, {provider: args.provider, parent: this});

        // The address appears in different places depending on the Kubernetes service provider.
        let address = service.status.loadBalancer.ingress[0].hostname;
        if (name === "gke" || name === "aks") {
            address = service.status.loadBalancer.ingress[0].ip;
        }

        this.appUrl = pulumi.interpolate`http://${address}:${service.spec.ports[0].port}`;

        this.registerOutputs();
    }
}
