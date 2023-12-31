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

import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export class GkeCluster extends pulumi.ComponentResource {
    public cluster: gcp.container.Cluster;
    public persistentVolumeClaim: k8s.core.v1.PersistentVolumeClaim;
    public provider: k8s.Provider;

    constructor(name: string,
                opts: pulumi.ComponentResourceOptions = {}) {
        super("examples:kubernetes-ts-multicloud:GkeCluster", name, {}, opts);

        const config = new pulumi.Config();


        // Create a GCP disk that will be used by the PersistentVolume
        const diskSize = config.requireNumber("filesVolumeSize");
        const diskName = "appDisk";

        /**
         * To have a Persistent Volume to be used in multiple nodes, we need to use Filestore service instead of Persistent Disks.
         *
         * GCP Persistent Disks do not support the ReadWriteMany access mode. GCP Persistent Disks can only be mounted
         * by a single node in read-write mode (ReadWriteOnce) or by multiple nodes in read-only mode (ReadOnlyMany)
         *
         * If you need a storage option that supports ReadWriteMany, you should use a file storage service like
         * Google Cloud Filestore, which can be used to create a Persistent Volume with ReadWriteMany access mode
         * in a Kubernetes cluster.
         */
        const fileStoreInstance = new gcp.filestore.Instance("nfs-instance", {
            tier: "STANDARD", // Other options include "PREMIUM" and "BASIC_HDD".
            fileShares: {
                name: diskName,
                capacityGb: diskSize, // The minimum capacity in GB for filestore is 1024GB and the monthly price is high, so, be careful when use this
            },
            networks: [{
                network: "default", // The name of the GCP network
                modes: ["MODE_IPV4"],
            }],
            location: "us-central1-a", // The GCP zone where the instance is created. For no costs of data transfer, should be the same as the cluster region/zone
        });

        // Assuming a standard StorageClass named "standard" is available in your cluster
        const storageClassName = "standard";

        // Define a PersistentVolume using the recommended GCP CSI storage class
        const persistentVolume = new k8s.core.v1.PersistentVolume("app-pv", {
            spec: {
                capacity: {
                    storage: `${diskSize}Gi`, // This should reflect the capacity of your Filestore volume
                },
                accessModes: ["ReadWriteMany"],
                persistentVolumeReclaimPolicy: "Retain",
                // Ensure the storageClassName is set and matches what is expected by the PVC
                storageClassName: storageClassName,
                nfs: {
                    path: `/${diskName}`,
                    server: fileStoreInstance.networks.apply(networks => networks[0].ipAddresses[0]),
                },
            },
        });

        // Create a PersistentVolumeClaim that a Pod can use to claim the PersistentVolume
        this.persistentVolumeClaim = new k8s.core.v1.PersistentVolumeClaim("app-pvc", {
            spec: {
                // Ensure the storageClassName matches the PV's storage class
                storageClassName: storageClassName,
                accessModes: ["ReadWriteMany"],
                resources: {
                    requests: {
                        storage: `${diskSize}Gi`,
                    },
                },
                volumeName: persistentVolume.metadata.name
            },
        });


        // Find the latest engine version.
        const engineVersion = gcp.container.getEngineVersions({}, {async: true}).then(v => v.latestMasterVersion);

        // Generate a strong password for the Kubernetes cluster.
        const password = new random.RandomPassword("password", {
            length: 20,
            special: true,
        }, {parent: this}).result;

        // Create the GKE cluster.
        const k8sCluster = new gcp.container.Cluster("cluster", {
            // We can't create a cluster with no node pool defined, but we want to only use
            // separately managed node pools. So we create the smallest possible default
            // node pool and immediately delete it.
            initialNodeCount: 1,
            removeDefaultNodePool: true,
            deletionProtection: false,

            minMasterVersion: engineVersion,
        }, {parent: this});

        const nodePool = new gcp.container.NodePool(`primary-node-pool`, {
            cluster: k8sCluster.name,
            initialNodeCount: 2,
            location: k8sCluster.location,
            nodeConfig: {
                preemptible: true,
                machineType: "n1-standard-1",
                oauthScopes: [
                    "https://www.googleapis.com/auth/compute",
                    "https://www.googleapis.com/auth/devstorage.read_only",
                    "https://www.googleapis.com/auth/logging.write",
                    "https://www.googleapis.com/auth/monitoring",
                ],
            },
            version: engineVersion,
            autoscaling: {
                minNodeCount: 2,
                maxNodeCount: 3, // Adjust maxNodeCount as needed
            },
            management: {
                autoRepair: true,
            },
        }, {
            dependsOn: [k8sCluster],
        });

        this.cluster = k8sCluster;

        // Manufacture a GKE-style Kubeconfig. Note that this is slightly "different" because of the way GKE requires
        // gcloud to be in the picture for cluster authentication (rather than using the client cert/key directly).
        const k8sConfig = pulumi.all([k8sCluster.name, k8sCluster.endpoint, k8sCluster.masterAuth]).apply(
            ([name, endpoint, auth]) => {
                const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
                return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${auth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`;
            });

        // Export a Kubernetes provider instance that uses our cluster from above.
        this.provider = new k8s.Provider("gke", {kubeconfig: k8sConfig}, {
            parent: this,
            dependsOn: [nodePool],
        });
    }
}

