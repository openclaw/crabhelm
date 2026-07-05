// Types the `cloudflare:test` module's `env` as the real Worker Env so DO and
// binding access in the workerd suite is checked against the deployment config.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
