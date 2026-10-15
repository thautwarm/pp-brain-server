import { AudioHelper, AudioAgent } from '@might/audio';

const stt = AudioAgent.sttModel({
    apiKey: process.env.STT_API_KEY ?? "",
    baseURL: process.env.STT_BASE_URL ?? "",
    model: 'qwen-asr',
})
const tts = AudioAgent.ttsModel({
    apiKey: process.env.TTS_API_KEY ?? "",
    baseURL: process.env.TTS_BASE_URL ?? "",
    model: 'moss-tts',
})

export async function callTranscript(audio: Uint8Array, options: { signal?: AbortSignal }): Promise<{ text: string }> {
    const it = await AudioAgent.transcribe({
        model: stt,
        audio: audio,
        abortSignal: options.signal,
        maxRetries: 3,
    })

    return { text: it.text }
}

export async function callVoiceGen(text: string, voice: string, options: { signal?: AbortSignal }): Promise<{ audio: Uint8Array }> {
    const it = await AudioAgent.synthesize({
        model: tts,
        text: text,
        voice: voice,
        abortSignal: options.signal,
        maxRetries: 3,
        outputFormat: 'opus' as any
    })

    if (it.audio.format !== 'ogg' && it.audio.format !== 'opus') {
        return { audio: await AudioHelper.convertToOggOpus(it.audio.uint8Array, undefined, { sampleRate: 24000 }) }
    }
    return { audio: it.audio.uint8Array }
}
