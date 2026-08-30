/**
 * Tool system types and permission classifications
 */

import type { ActionManager } from '../actions/ActionManager';
import type { ComputerAuthorizationManager, ComputerCapability } from '../authorization/ComputerAuthorizationManager';

export enum ToolPermissionLevel {
  READ_ONLY = 'READ_ONLY',
  LOW_RISK_ACTION = 'LOW_RISK_ACTION',
  SENSITIVE_ACTION = 'SENSITIVE_ACTION',
  DANGEROUS_ACTION = 'DANGEROUS_ACTION',
}

export interface ToolExecutionContext {
  sessionId?: string;
  executionId?: string;
  userConfirmed?: boolean;
  actionManager?: ActionManager;
  authorizationManager?: ComputerAuthorizationManager;
  speakerId?: string;
}

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  userMessage?: string;
}

export interface ToolParameterProperty {
  type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParametersSchema {
  type: 'OBJECT';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  permissionLevel: ToolPermissionLevel;
  capability?: ComputerCapability;
  capabilityForArgs?: (args: unknown) => ComputerCapability;
  parameters: ToolParametersSchema;
  validateArgs: (args: unknown) => { valid: boolean; error?: string; parsedArgs?: TArgs };
  execute: (args: TArgs, context?: ToolExecutionContext) => Promise<ToolExecutionResult<TResult>>;
}

