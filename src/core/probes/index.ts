import { withClient } from "../db.ts";
import type { Finding } from "../findings.ts";
import { type ProbeTarget, probeAnonRead } from "./p001.ts";

export interface ProbeResults {
  findings: Finding[];
  unverified: ProbeTarget[];
}

export interface ProbeOptions {
  schemas: string[];
}

export async function runProbes(dbUrl: string, opts: ProbeOptions): Promise<ProbeResults> {
  return withClient(dbUrl, async (client) => {
    const p001 = await probeAnonRead(client, opts.schemas);
    return { findings: p001.findings, unverified: p001.unverified };
  });
}
