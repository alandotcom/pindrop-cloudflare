// Teaches cloudflare:test about this Worker's bindings, so `env` in tests is
// typed with `Comments` and `ALLOWED_ORIGINS`. `Env` is the global interface
// generated into worker-configuration.d.ts by `wrangler types`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
