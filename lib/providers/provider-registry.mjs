// Which generation providers this installation has, and nothing more.
//
// The registry is EMPTY by default. That is deliberate: shipping a default provider would mean shipping an
// integration with somebody else's service, and an operator should have to say which service they intend to
// spend money at. `AVC_STUDIO_PROVIDER_PLUGINS` is a path list; each entry is imported and its default export
// registered.

import { assertValidPlugin, assertPlanSupported, PROVIDER_ERRORS } from "./provider-plugin.mjs";

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }

export function createProviderRegistry() {
  const plugins = new Map();      // id -> plugin
  const capabilities = new Map(); // id -> frozen capability

  return Object.freeze({
    /** Register one plugin. Throws rather than overwrite: two plugins claiming one id is a config error. */
    register(plugin) {
      const { id, capability } = assertValidPlugin(plugin);
      if (plugins.has(id)) throw err(PROVIDER_ERRORS.DUPLICATE_PROVIDER, `provider ${id} is already registered`, { id });
      plugins.set(id, plugin);
      capabilities.set(id, capability);
      return id;
    },

    /**
     * Import every module in `paths` and register its default export.
     * Import failures are reported with the path that failed — a silent skip would leave an installation
     * quietly unable to generate, which looks identical to a provider outage.
     */
    async loadFrom(paths = []) {
      const loaded = [];
      for (const p of paths) {
        let mod;
        try { mod = await import(p); }
        catch (cause) { throw err(PROVIDER_ERRORS.INVALID_PLUGIN, `provider plugin at ${p} could not be imported: ${cause.message}`, { path: p }); }
        loaded.push(this.register(mod.default ?? mod));
      }
      return loaded;
    },

    /** Load from the environment. Empty env → empty registry, which is a valid state. */
    async loadFromEnv(env = process.env) {
      const raw = (env.AVC_STUDIO_PROVIDER_PLUGINS || "").trim();
      if (!raw) return [];
      return this.loadFrom(raw.split(/[;,]/u).map((s) => s.trim()).filter(Boolean));
    },

    has: (id) => plugins.has(id),
    ids: () => [...plugins.keys()].sort(),
    capabilityOf(id) {
      if (!capabilities.has(id)) throw err(PROVIDER_ERRORS.UNKNOWN_PROVIDER, `no provider ${id} is registered`, { id, available: [...plugins.keys()] });
      return capabilities.get(id);
    },
    get(id) {
      if (!plugins.has(id)) throw err(PROVIDER_ERRORS.UNKNOWN_PROVIDER, `no provider ${id} is registered`, { id, available: [...plugins.keys()] });
      return plugins.get(id);
    },

    /** Resolve the plugin for a plan, refusing before any spend if it cannot render it. */
    resolveFor(id, plan) {
      const plugin = this.get(id);
      assertPlanSupported(this.capabilityOf(id), plan);
      return plugin;
    },

    async dispose() {
      for (const p of plugins.values()) { if (typeof p.dispose === "function") await p.dispose(); }
      plugins.clear();
      capabilities.clear();
    }
  });
}
