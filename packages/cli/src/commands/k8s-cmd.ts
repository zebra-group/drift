import { Command } from "commander";
import { k8s } from "@db-mirror/core";

export function k8sCommand(): Command {
  const cmd = new Command("k8s").description("Kubernetes helpers");

  cmd
    .command("contexts")
    .description("List contexts in kubeconfig")
    .option("--kubeconfig <file>", "custom kubeconfig path")
    .action(async (opts) => {
      const c = new k8s.K8sClient(opts.kubeconfig);
      for (const name of c.listContexts()) console.log(name);
    });

  cmd
    .command("namespaces")
    .description("List namespaces in a context")
    .requiredOption("--context <ctx>", "kube context")
    .option("--kubeconfig <file>", "custom kubeconfig path")
    .action(async (opts) => {
      const c = new k8s.K8sClient(opts.kubeconfig);
      for (const n of await c.listNamespaces(opts.context)) console.log(n);
    });

  cmd
    .command("pods")
    .description("List pods in a namespace")
    .requiredOption("--context <ctx>", "kube context")
    .requiredOption("--namespace <ns>", "namespace")
    .option("--kubeconfig <file>", "custom kubeconfig path")
    .action(async (opts) => {
      const c = new k8s.K8sClient(opts.kubeconfig);
      for (const p of await c.listPods(opts.namespace, opts.context)) console.log(p);
    });

  cmd
    .command("services")
    .description("List services in a namespace")
    .requiredOption("--context <ctx>", "kube context")
    .requiredOption("--namespace <ns>", "namespace")
    .option("--kubeconfig <file>", "custom kubeconfig path")
    .action(async (opts) => {
      const c = new k8s.K8sClient(opts.kubeconfig);
      for (const s of await c.listServices(opts.namespace, opts.context)) console.log(s);
    });

  return cmd;
}
