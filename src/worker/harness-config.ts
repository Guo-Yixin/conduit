/**
 * CONDUIT_HARNESS_* engine-config parser (WI-586).
 *
 * Pure function: reads only the passed-in env record, does no I/O, and does
 * not validate adapter names against the shipped factory map (that's the
 * registry's job — see harness-config.test.ts header for the full contract).
 */

export type HarnessConfigResult =
  | { ok: true; defs: HarnessAdapterConfigDef[] }
  | { ok: false; error: string };

export interface HarnessAdapterConfigDef {
  name: string;
  envAllowlist: string[];
  command?: string;
  model?: string;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function derivePrefix(name: string): string {
  return `CONDUIT_HARNESS_${name.toUpperCase().replace(/-/g, '_')}_`;
}

export function parseHarnessConfig(env: Record<string, string | undefined>): HarnessConfigResult {
  const adaptersRaw = env.CONDUIT_HARNESS_ADAPTERS;
  if (adaptersRaw === undefined || adaptersRaw.trim() === '') {
    return { ok: true, defs: [] };
  }

  const names = splitCsv(adaptersRaw);

  const prefixToNames = new Map<string, string[]>();
  for (const name of names) {
    const prefix = derivePrefix(name);
    const existing = prefixToNames.get(prefix);
    if (existing) {
      existing.push(name);
    } else {
      prefixToNames.set(prefix, [name]);
    }
  }
  for (const [, collidingNames] of prefixToNames) {
    if (collidingNames.length > 1) {
      return {
        ok: false,
        error: `harness config: adapter names collide on the same derived env prefix: ${collidingNames.join(', ')}`,
      };
    }
  }

  const defs: HarnessAdapterConfigDef[] = [];
  for (const name of names) {
    const prefix = derivePrefix(name);
    const envVarName = `${prefix}ENV`;
    const envAllowlistRaw = env[envVarName];
    if (envAllowlistRaw === undefined) {
      return {
        ok: false,
        error: `harness config: adapter "${name}" is missing required env allowlist var ${envVarName}`,
      };
    }

    const def: HarnessAdapterConfigDef = {
      name,
      envAllowlist: splitCsv(envAllowlistRaw),
    };

    const command = env[`${prefix}COMMAND`];
    if (command !== undefined) {
      def.command = command;
    }

    const model = env[`${prefix}MODEL`];
    if (model !== undefined) {
      def.model = model;
    }

    defs.push(def);
  }

  return { ok: true, defs };
}
