import type { RoleRuntime } from '@speedpatrol/core';
import type { Runtime } from '../types.js';
import { CliRuntime } from './cli.js';
import { ModelRuntime } from './model.js';

export function createRuntime(use: RoleRuntime): Runtime {
  return use.runtime === 'cli' ? new CliRuntime(use) : new ModelRuntime(use);
}
