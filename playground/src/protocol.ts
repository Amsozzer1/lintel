import type { Outcome } from "./engine.ts";

export type ToWorker =
  | { type: "boot"; base: string }
  | { type: "run"; id: number; migration: string; seed: string };

export type ToPage =
  | { type: "progress"; loaded: number; total: number }
  | { type: "starting" }
  | { type: "ready"; ms: number }
  | { type: "failed"; message: string }
  | { type: "started"; id: number }
  | { type: "result"; id: number; outcome: Outcome };
