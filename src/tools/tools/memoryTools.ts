import { defaultMemoryManager } from '../../memory/MemoryManager';
import { MemoryCategory } from '../../memory/memoryTypes';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface RememberArgs { fact: string; category?: MemoryCategory; key?: string; confidence?: 'high' | 'medium' | 'low'; }
interface RecallArgs { query?: string; }
interface ForgetArgs { target: string; }

const categories: MemoryCategory[] = ['identity', 'preference', 'project', 'routine', 'relationship', 'skill', 'other'];

export const rememberInformationTool: ToolDefinition<RememberArgs> = {
  name: 'rememberInformation',
  description: 'Save or update one durable user fact when explicitly asked. Always remember identity facts such as name, location, date of birth, birthday, and birth date. Infer the simple category and stable subject key when possible.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: { type: 'OBJECT', properties: { fact: { type: 'STRING', description: 'Short fact in third person.' }, category: { type: 'STRING', description: 'Optional simple category.', enum: categories }, key: { type: 'STRING', description: 'Optional stable key for updating an existing detail.' }, confidence: { type: 'STRING', description: 'Confidence level.', enum: ['high', 'medium', 'low'] } }, required: ['fact'] },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object' || typeof (args as any).fact !== 'string' || !(args as any).fact.trim()) return { valid: false, error: 'A fact is required.' };
    const value = args as any;
    return { valid: true, parsedArgs: { fact: value.fact.trim(), category: categories.includes(value.category) ? value.category : undefined, key: typeof value.key === 'string' ? value.key : undefined, confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'high' } };
  },
  async execute(args, context) {
    const memory = context?.speakerId
      ? await defaultMemoryManager.rememberForSpeaker(context.speakerId, args.fact, args.category, args.key, args.confidence)
      : await defaultMemoryManager.remember(args.fact, args.category, args.key, args.confidence);
    return memory ? { success: true, userMessage: 'Saved to memory.', data: { id: memory.id, fact: memory.fact, category: memory.category } } : { success: false, error: 'That information cannot be saved.' };
  },
};

export const recallInformationTool: ToolDefinition<RecallArgs> = {
  name: 'recallInformation',
  description: 'Retrieve the most relevant saved facts when answering questions about the user.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Topic or question to search.' } } },
  validateArgs(args: unknown) { return { valid: true, parsedArgs: { query: args && typeof args === 'object' && typeof (args as any).query === 'string' ? (args as any).query.trim() : '' } }; },
  async execute(args, context) { const results = context?.speakerId ? await defaultMemoryManager.recallForSpeaker(context.speakerId, args.query) : await defaultMemoryManager.recall(args.query); return { success: true, data: { memories: results.map(({ item }) => ({ category: item.category, fact: item.fact })) }, userMessage: results.length ? results.map(({ item }) => item.fact).join('; ') : 'No matching memories found.' }; },
};

export const forgetInformationTool: ToolDefinition<ForgetArgs> = {
  name: 'forgetInformation',
  description: 'Delete a saved fact when explicitly requested.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: { type: 'OBJECT', properties: { target: { type: 'STRING', description: 'Memory ID or exact saved fact.' } }, required: ['target'] },
  validateArgs(args: unknown) { if (!args || typeof args !== 'object' || typeof (args as any).target !== 'string' || !(args as any).target.trim()) return { valid: false, error: 'A memory target is required.' }; return { valid: true, parsedArgs: { target: (args as any).target.trim() } }; },
  async execute(args) { const deleted = await defaultMemoryManager.forget(args.target); return { success: deleted, userMessage: deleted ? 'Forgotten.' : 'I could not find that memory.' }; },
};
