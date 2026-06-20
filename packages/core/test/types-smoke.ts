/**
 * Types smoke test (compile-only). Guards the schema→TS codegen: if a future bump of
 * json-schema-to-typescript silently drops or renames one of the 11 public-API ("ROOT")
 * types, `tsc --noEmit` over this file fails. No runtime assertions needed.
 *
 * The 11 ROOT_SCHEMAS are defined in scripts/generate-types.js (Serializable* → clean names).
 */
import type {
  ScriptContext,
  MachineContext,
  MachineState,
  Budget,
  Term,
  Value,
  ExecutionStatus,
  MachineStateLazy,
  MachineContextLazy,
  ValueLazy,
  EnvLazy,
} from '../src/debugger-types';

// A tuple referencing every root type — fails to compile if any is missing/unexported.
export type RootSchemas = [
  ScriptContext,
  MachineContext,
  MachineState,
  Budget,
  Term,
  Value,
  ExecutionStatus,
  MachineStateLazy,
  MachineContextLazy,
  ValueLazy,
  EnvLazy,
];

// Sanity: ExecutionStatus must be the discriminated union the engine returns.
const _ready: ExecutionStatus = { status_type: 'Ready' };
const _err: ExecutionStatus = { status_type: 'Error', message: 'x' };
void _ready;
void _err;
