import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
// import * as aks from "./aks";
import * as app from "./app";
// import * as eks from "./eks";
import * as gke from "./gke";
// import * as local from "./local";

// Create Kubernetes clusters.
// Note: Comment out lines for any cluster you don't want to deploy.
// const aksCluster = new aks.AksCluster("multicloud", {});
// const eksCluster = new eks.EksCluster("multicloud", {});
const gkeCluster = new gke.GkeCluster("multicloud", {});

// Create a list of named clusters where the demo app will be deployed.
interface Cluster {
    name: string;
    provider: k8s.Provider;
    staticAppIP?: pulumi.Output<string>;
    pvc: k8s.core.v1.PersistentVolumeClaim;
}
const clusters: Cluster[] = [
    // Note: Comment out lines for any cluster you don't want to deploy.
    // {name: "aks", provider: aksCluster.provider, staticAppIP: aksCluster.staticAppIP},
    // {name: "eks", provider: eksCluster.provider},
    {name: "gke", provider: gkeCluster.provider, pvc: gkeCluster.persistentVolumeClaim},
    // {name: "local", provider: local.provider},
];

// Export a list of URLs to access the demo app.
interface AppUrl {
    name: string;
    url: pulumi.Output<string>;
}
export let appUrls: AppUrl[] = [];

const appImageTag = process.env.IMAGE_TAG || 'latest';
// const kuardImageTag = "green";

// Create the application on each of the selected clusters.
for (const cluster of clusters) {
    const instance = new app.DemoApp(cluster.name, {
        provider: cluster.provider,
        imageTag: appImageTag,
        staticAppIP: cluster.staticAppIP,
        pvc: cluster.pvc,
    });

    const instanceUrl: AppUrl = {name: cluster.name, url: instance.appUrl};
    appUrls = appUrls.concat(instanceUrl);
}
