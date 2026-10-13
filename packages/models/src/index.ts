// @might/models
import * as deepseek from './deepseek.ts';
import type { LanguageModelCard } from './types.ts';

export {
    deepseek
};

export const languageModelCards: Record<string, LanguageModelCard> = {
    deepseek: deepseek satisfies LanguageModelCard,
}
