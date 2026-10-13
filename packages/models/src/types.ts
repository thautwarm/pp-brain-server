import { z } from 'zod';
import type { LanguageModel, LanguageModelCallOptions } from '@might/chat-core';

export type ModelAuth =
    | { apiKey: string }

export interface Credential {
    auth: ModelAuth;
    baseURL: string;
}

export interface CreateModelOptions<Args> {
    args: Args;
    credential: Credential;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
}

export interface LanguageModelCard {
    name: string;
    parameters: z.ZodType<any>;
    prepare: (options: CreateModelOptions<any>) => {
        languageModel: LanguageModel;
        generation: LanguageModelCallOptions;
        providerOptions: Record<string, any>;
    };


}
