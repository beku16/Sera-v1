import { ColorPaletteId } from '../../types';
import { PREDEFINED_PALETTES } from '../../config/palettes';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface SetPaletteArgs {
  palette: ColorPaletteId;
}

export const setAtmosphericPaletteTool: ToolDefinition<SetPaletteArgs, { palette: ColorPaletteId; name: string }> = {
  name: 'setAtmosphericPalette',
  description: 'Changes SERA\'s atmospheric color palette to match the user\'s requested mood or color. Use this whenever the user asks to change the interface atmosphere, theme color, or visual mood.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: {
    type: 'OBJECT',
    properties: {
      palette: {
        type: 'STRING',
        description: 'Palette identifier selected from the available atmospheric palettes.',
        enum: Object.keys(PREDEFINED_PALETTES),
      },
    },
    required: ['palette'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Palette arguments are required.' };
    const palette = String((args as Record<string, unknown>).palette || '');
    if (!(palette in PREDEFINED_PALETTES)) return { valid: false, error: `Unknown atmospheric palette: ${palette}` };
    return { valid: true, parsedArgs: { palette: palette as ColorPaletteId } };
  },
  async execute(args) {
    return {
      success: true,
      userMessage: `Atmosphere changed to ${PREDEFINED_PALETTES[args.palette].name}.`,
      data: { palette: args.palette, name: PREDEFINED_PALETTES[args.palette].name },
    };
  },
};