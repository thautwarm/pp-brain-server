export type ModelAuth =
    | { apiKey: string }

export interface Credential {
    auth: ModelAuth;
    baseURL: string;
}