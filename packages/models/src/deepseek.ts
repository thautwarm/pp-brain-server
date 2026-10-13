import { z } from 'zod';
import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import type { LanguageModel, LanguageModelCallOptions } from '@might/chat-core';
import type { CreateModelOptions } from './types.ts';
import { createDeepSeek } from '@ai-sdk/deepseek';

export const name = "deepseek";

export const parameters = z.object({
    temperature: z.number().min(0).max(2).optional(),
    level: z.enum(['off', 'low', 'high', 'max']).optional(),
    context: z.number().int().min(1024 * 16).max(1_000_000).optional(),
    maxOutputTokens: z.number().int().min(4096).max(384_000).optional()
})

export function prepare(
    options: CreateModelOptions<z.infer<typeof parameters>>
): {
    generation: LanguageModelCallOptions,
    providerOptions: DeepSeekLanguageModelOptions,
    languageModel: LanguageModel
} {
    const { args, credential, fetch, headers } = options;
    const providerOptions: DeepSeekLanguageModelOptions = {};
    const generation: LanguageModelCallOptions = {};
    generation.maxOutputTokens = args.maxOutputTokens;

    const languageModel = createDeepSeek({
        apiKey: credential.auth.apiKey,
        baseURL: credential.baseURL,
        fetch,
        headers
    }) as unknown as LanguageModel;

    // default: 1.0 (https://api-docs.deepseek.com/quick_start/parameter_settings/)
    generation.temperature = args.temperature ?? 1;

    switch (args.level) {
        case 'off':
            providerOptions.reasoningEffort = undefined;
            providerOptions.thinking = { type: 'disabled' };
            break;
        default:
            providerOptions.reasoningEffort = args.level;
            providerOptions.thinking = { type: 'enabled' };
            break;
    }
    return {
        languageModel,
        generation,
        providerOptions
    }
}